import 'dotenv/config';
import { getPendingWorkflows, updateWorkflow } from './state.js';
import { getIssue, transitionIssue, addComment } from './jira.js';
import { resolveIds, executeRunbook, getTaskStatus } from './octopus.js';

const POLL_INTERVAL_MS = (process.env.POLL_INTERVAL_SECONDS || 300) * 1000;
const APPROVED_STATUS = process.env.JIRA_APPROVED_STATUS || 'In Progress';

let octopusIds = null;

async function getOctopusIds() {
  if (octopusIds) return octopusIds;
  octopusIds = await resolveIds(
    process.env.OCTOPUS_SPACE_NAME,
    process.env.OCTOPUS_PROJECT_NAME,
    process.env.OCTOPUS_RUNBOOK_NAME,
    process.env.OCTOPUS_ENVIRONMENT_NAME,
  );
  return octopusIds;
}

async function processWorkflow(workflow) {
  const { ticketKey, keyword, status } = workflow;

  switch (status) {
    case 'awaiting_approval': {
      const issue = await getIssue(ticketKey);
      const currentStatus = issue.fields.status.name;
      if (currentStatus === APPROVED_STATUS) {
        console.log(`[${ticketKey}] Approved (status: ${currentStatus})`);
        await updateWorkflow(ticketKey, { status: 'approved' });
      } else {
        console.log(`[${ticketKey}] Still awaiting approval (status: ${currentStatus})`);
      }
      break;
    }

    case 'approved': {
      console.log(`[${ticketKey}] Triggering Octopus runbook with keyword: ${keyword}`);
      const ids = await getOctopusIds();
      const { taskId } = await executeRunbook(
        ids.spaceId,
        ids.runbookId,
        ids.publishedSnapshotId,
        ids.environmentId,
        { Keyword: keyword },
      );
      console.log(`[${ticketKey}] Runbook task started: ${taskId}`);
      await addComment(ticketKey, `Octopus runbook triggered. Task ID: ${taskId}`);
      await updateWorkflow(ticketKey, { status: 'runbook_running', octopusTaskId: taskId });
      break;
    }

    case 'runbook_running': {
      const task = await getTaskStatus(workflow.octopusTaskId);
      if (task.isCompleted) {
        if (task.finishedSuccessfully) {
          console.log(`[${ticketKey}] Runbook completed successfully`);
          await addComment(ticketKey, 'Octopus runbook completed successfully. Closing ticket.');
          await updateWorkflow(ticketKey, { status: 'runbook_complete' });
        } else {
          console.error(`[${ticketKey}] Runbook failed: ${task.errorMessage}`);
          await addComment(ticketKey, `Octopus runbook failed: ${task.errorMessage}`);
          await updateWorkflow(ticketKey, { status: 'runbook_failed' });
        }
      } else {
        console.log(`[${ticketKey}] Runbook still running (state: ${task.state})`);
      }
      break;
    }

    case 'runbook_complete': {
      console.log(`[${ticketKey}] Transitioning Jira ticket to Done`);
      await transitionIssue(ticketKey, 'Done');
      await updateWorkflow(ticketKey, { status: 'done' });
      console.log(`[${ticketKey}] Workflow complete`);
      break;
    }

    case 'runbook_failed': {
      console.log(`[${ticketKey}] Skipping (runbook failed - needs manual intervention)`);
      break;
    }
  }
}

async function pollOnce() {
  const workflows = await getPendingWorkflows();
  if (workflows.length === 0) {
    console.log(`[poll] No pending workflows`);
    return;
  }
  console.log(`[poll] Processing ${workflows.length} pending workflow(s)`);
  for (const workflow of workflows) {
    try {
      await processWorkflow(workflow);
    } catch (err) {
      console.error(`[${workflow.ticketKey}] Error: ${err.message}`);
    }
  }
}

// Graceful shutdown
let running = true;
process.on('SIGINT', () => { running = false; console.log('\nShutting down...'); });
process.on('SIGTERM', () => { running = false; console.log('\nShutting down...'); });

console.log(`Clautobot poller started. Checking every ${POLL_INTERVAL_MS / 1000}s.`);
console.log(`Approved status: "${APPROVED_STATUS}"`);

// Run immediately on start, then on interval
await pollOnce();
while (running) {
  await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  if (running) await pollOnce();
}

console.log('Poller stopped.');
