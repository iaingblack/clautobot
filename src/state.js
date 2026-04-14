import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { bus } from './events.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(__dirname, '..', 'state');

export async function createWorkflow(ticketKey, workflowType, params, jiraUrl) {
  const workflow = {
    ticketKey,
    workflowType,
    status: 'awaiting_approval',
    params,
    jiraUrl,
    octopusTaskId: null,
    runbookLog: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(join(STATE_DIR, `${ticketKey}.json`), JSON.stringify(workflow, null, 2));
  bus.emit('workflow-update', { ticketKey, status: workflow.status, workflow });
  return workflow;
}

export async function getWorkflow(ticketKey) {
  const data = await readFile(join(STATE_DIR, `${ticketKey}.json`), 'utf-8');
  return JSON.parse(data);
}

export async function updateWorkflow(ticketKey, updates) {
  const workflow = await getWorkflow(ticketKey);
  const prevStatus = workflow.status;
  Object.assign(workflow, updates, { updatedAt: new Date().toISOString() });
  await writeFile(join(STATE_DIR, `${ticketKey}.json`), JSON.stringify(workflow, null, 2));
  if (workflow.status !== prevStatus) {
    bus.emit('workflow-update', { ticketKey, status: workflow.status, workflow });
  }
  return workflow;
}

export async function getPendingWorkflows() {
  const all = await getAllWorkflows();
  return all.filter(w => w.status !== 'done');
}

export async function getAllWorkflows() {
  const files = await readdir(STATE_DIR);
  const workflows = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const data = await readFile(join(STATE_DIR, file), 'utf-8');
    const parsed = JSON.parse(data);
    // Skip non-workflow JSON files (e.g. chat-sessions.json) that share this dir.
    if (!parsed.ticketKey || !parsed.workflowType) continue;
    workflows.push(parsed);
  }
  return workflows.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}
