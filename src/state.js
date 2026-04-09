import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(__dirname, '..', 'state');

export async function createWorkflow(ticketKey, keyword, jiraUrl) {
  const workflow = {
    ticketKey,
    keyword,
    status: 'awaiting_approval',
    jiraUrl,
    octopusTaskId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(join(STATE_DIR, `${ticketKey}.json`), JSON.stringify(workflow, null, 2));
  return workflow;
}

export async function getWorkflow(ticketKey) {
  const data = await readFile(join(STATE_DIR, `${ticketKey}.json`), 'utf-8');
  return JSON.parse(data);
}

export async function updateWorkflow(ticketKey, updates) {
  const workflow = await getWorkflow(ticketKey);
  Object.assign(workflow, updates, { updatedAt: new Date().toISOString() });
  await writeFile(join(STATE_DIR, `${ticketKey}.json`), JSON.stringify(workflow, null, 2));
  return workflow;
}

export async function getPendingWorkflows() {
  const files = await readdir(STATE_DIR);
  const workflows = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const data = await readFile(join(STATE_DIR, file), 'utf-8');
    const workflow = JSON.parse(data);
    if (workflow.status !== 'done') {
      workflows.push(workflow);
    }
  }
  return workflows;
}
