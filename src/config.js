import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'workflows.yml');

export function loadWorkflows() {
  const raw = readFileSync(CONFIG_PATH, 'utf-8');
  const config = yaml.load(raw);

  if (!config?.workflows || typeof config.workflows !== 'object') {
    throw new Error('workflows.yml must have a top-level "workflows" object');
  }

  const workflows = {};
  for (const [name, wf] of Object.entries(config.workflows)) {
    if (!wf.jira?.project || !wf.jira?.approvedStatus) {
      throw new Error(`Workflow "${name}": jira requires project and approvedStatus`);
    }
    if (wf.jira.customFieldFilter) {
      if (!wf.jira.customFieldFilter.field || !wf.jira.customFieldFilter.value) {
        throw new Error(`Workflow "${name}": customFieldFilter requires both field and value`);
      }
    }
    if (!wf.octopus?.space || !wf.octopus?.project || !wf.octopus?.runbook || !wf.octopus?.environment) {
      throw new Error(`Workflow "${name}": octopus requires space, project, runbook, and environment`);
    }
    workflows[name] = wf;
  }

  return workflows;
}
