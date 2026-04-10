import 'dotenv/config';
import { loadWorkflows } from './config.js';
import { discoverTickets } from './discovery.js';
import { getPendingWorkflows, updateWorkflow } from './state.js';
import { getIssue, transitionIssue, addComment } from './jira.js';
import { resolveIds, executeRunbook, getTaskStatus, getTaskLog } from './octopus.js';
import { startWeb } from './web.js';

const POLL_INTERVAL_MS = (process.env.POLL_INTERVAL_SECONDS || 300) * 1000;

// Cache resolved Octopus IDs per workflow type
const octopusIdCache = {};

function log(tag, message) {
  const ts = new Date().toISOString();
  console.log(`${ts} [${tag}] ${message}`);
}

function logError(tag, message) {
  const ts = new Date().toISOString();
  console.error(`${ts} [${tag}] ${message}`);
}

async function getOctopusIds(workflowName, octopusConfig) {
  if (octopusIdCache[workflowName]) return octopusIdCache[workflowName];
  const ids = await resolveIds(
    octopusConfig.space,
    octopusConfig.project,
    octopusConfig.runbook,
    octopusConfig.environment,
  );
  octopusIdCache[workflowName] = ids;
  return ids;
}

async function processWorkflow(workflow, workflowConfig) {
  const { ticketKey, status, params } = workflow;

  switch (status) {
    case 'awaiting_approval': {
      const issue = await getIssue(ticketKey);
      const currentStatus = issue.fields.status.name;
      if (currentStatus === workflowConfig.jira.approvedStatus) {
        log(ticketKey, `Approved (status: ${currentStatus})`);
        await updateWorkflow(ticketKey, { status: 'approved' });
      } else {
        log(ticketKey, `Still awaiting approval (status: ${currentStatus})`);
      }
      break;
    }

    case 'approved': {
      log(ticketKey, `Triggering Octopus runbook: ${workflowConfig.octopus.runbook}`);
      const ids = await getOctopusIds(workflow.workflowType, workflowConfig.octopus);
      const { taskId } = await executeRunbook(
        ids.spaceId,
        ids.runbookId,
        ids.publishedSnapshotId,
        ids.environmentId,
        params || {},
      );
      const taskUrl = `${process.env.OCTOPUS_SERVER_URL}/app#/${ids.spaceId}/tasks/${taskId}`;
      log(ticketKey, `Runbook task started: ${taskUrl}`);
      await addComment(ticketKey, `Octopus runbook triggered.\n\nTask: ${taskUrl}`);
      await updateWorkflow(ticketKey, { status: 'runbook_running', octopusTaskId: taskId });
      break;
    }

    case 'runbook_running': {
      const task = await getTaskStatus(workflow.octopusTaskId);
      if (task.isCompleted) {
        const taskLog = await getTaskLog(workflow.octopusTaskId);
        if (task.finishedSuccessfully) {
          log(ticketKey, 'Runbook completed successfully');
          log(ticketKey, `Output:\n${taskLog}`);
          await addComment(ticketKey, `Octopus runbook completed successfully.\n\nTask: ${process.env.OCTOPUS_SERVER_URL}/app#/tasks/${workflow.octopusTaskId}\n\nOutput:\n{noformat}${taskLog}{noformat}`);
          await updateWorkflow(ticketKey, { status: 'runbook_complete', runbookLog: taskLog });
        } else {
          logError(ticketKey, `Runbook failed: ${task.errorMessage}`);
          log(ticketKey, `Output:\n${taskLog}`);
          await addComment(ticketKey, `Octopus runbook failed: ${task.errorMessage}\n\nOutput:\n{noformat}${taskLog}{noformat}`);
          await updateWorkflow(ticketKey, { status: 'runbook_failed', runbookLog: taskLog });
        }
      } else {
        log(ticketKey, `Runbook still running (state: ${task.state})`);
      }
      break;
    }

    case 'runbook_complete': {
      log(ticketKey, 'Transitioning Jira ticket to Done');
      await transitionIssue(ticketKey, 'Done');
      await updateWorkflow(ticketKey, { status: 'done' });
      log(ticketKey, 'Workflow complete');
      break;
    }

    case 'runbook_failed': {
      log(ticketKey, 'Skipping (runbook failed - needs manual intervention)');
      break;
    }
  }
}

async function pollOnce(workflows, pollerState) {
  pollerState.lastPollAt = new Date().toISOString();
  pollerState.pollCount++;

  // Phase 1: Discover new tickets from Jira
  for (const [name, config] of Object.entries(workflows)) {
    try {
      const discovered = await discoverTickets(name, config);
      for (const key of discovered) {
        log('discovery', `New ticket found: ${key} (workflow: ${name})`);
      }
    } catch (err) {
      logError('discovery', `Error scanning ${name}: ${err.message}`);
    }
  }

  // Phase 2: Process existing workflows
  const pending = await getPendingWorkflows();
  if (pending.length === 0) {
    log('poll', 'No pending workflows');
    return;
  }
  log('poll', `Processing ${pending.length} pending workflow(s)`);
  for (const workflow of pending) {
    const config = workflows[workflow.workflowType];
    if (!config) {
      logError(workflow.ticketKey, `Unknown workflow type: ${workflow.workflowType}`);
      continue;
    }
    try {
      await processWorkflow(workflow, config);
    } catch (err) {
      logError(workflow.ticketKey, `Error: ${err.message}`);
    }
  }
}

// --- Startup ---

const requiredEnv = ['OCTOPUS_SERVER_URL', 'OCTOPUS_API_KEY', 'JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'];
const missing = requiredEnv.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const workflows = loadWorkflows();
const workflowNames = Object.keys(workflows);

const pollerState = {
  startedAt: new Date().toISOString(),
  lastPollAt: null,
  pollCount: 0,
  workflowConfigs: workflowNames,
};

log('startup', `Clautobot poller started. Checking every ${POLL_INTERVAL_MS / 1000}s.`);
log('startup', `Loaded ${workflowNames.length} workflow(s): ${workflowNames.join(', ')}`);

const webServer = startWeb(pollerState, workflows);

// Graceful shutdown
let running = true;
let shuttingDown = false;
let sleepTimer = null;
let wakeSleep = null;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  running = false;
  log('shutdown', `Received ${signal}`);
  if (sleepTimer) clearTimeout(sleepTimer);
  if (wakeSleep) wakeSleep();
  webServer.close(() => {
    log('shutdown', 'Poller stopped.');
    process.exit(0);
  });
  // Force-exit if close() hangs
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Run immediately on start, then on interval
await pollOnce(workflows, pollerState);
while (running) {
  await new Promise(resolve => {
    wakeSleep = resolve;
    sleepTimer = setTimeout(resolve, POLL_INTERVAL_MS);
  });
  if (running) await pollOnce(workflows, pollerState);
}
