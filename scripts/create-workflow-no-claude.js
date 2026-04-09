#!/usr/bin/env node
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { createIssue, addComment } from '../src/jira.js';
import { createWorkflow } from '../src/state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const [workflowName, ...paramParts] = process.argv.slice(2);
const paramValue = paramParts.join(' ');

if (!workflowName) {
  console.error('Usage: node scripts/create-workflow-no-claude.js <workflow-name> <param-value>');
  console.error('Example: node scripts/create-workflow-no-claude.js create-evidence-file myvalue');
  process.exit(1);
}

// Load workflow config
const raw = readFileSync(join(__dirname, '..', 'workflows.yml'), 'utf-8');
const config = yaml.load(raw);
const wf = config.workflows?.[workflowName];

if (!wf) {
  const available = Object.keys(config.workflows || {}).join(', ');
  console.error(`Unknown workflow: "${workflowName}". Available: ${available}`);
  process.exit(1);
}

// Build params from the first defined param and the CLI argument
const params = {};
const paramNames = Object.keys(wf.params || {});
if (paramNames.length > 0 && !paramValue) {
  console.error(`This workflow requires a value for: ${paramNames[0]}`);
  console.error(`Usage: node scripts/create-workflow-no-claude.js ${workflowName} <${paramNames[0]}>`);
  process.exit(1);
}
if (paramNames.length > 0) {
  params[paramNames[0]] = paramValue;
}

// Create the Jira ticket
const summary = `${wf.description}: ${paramValue}`;
const description = `Automated change request from clautobot.\n\nWorkflow: ${workflowName}\nParameter: ${paramValue}\n\nOnce this ticket is moved to "${wf.jira.approvedStatus}", the Octopus runbook "${wf.octopus.runbook}" will execute automatically.`;

const issue = await createIssue(wf.jira.project, summary, description, [wf.jira.label]);
const ticketKey = issue.key;
const jiraUrl = `${process.env.JIRA_BASE_URL}/browse/${ticketKey}`;

await addComment(ticketKey, `Created by clautobot automation. The background poller will proceed when this ticket is moved to "${wf.jira.approvedStatus}".`);

// Write state file
await createWorkflow(ticketKey, workflowName, params, jiraUrl);

console.log(`Ticket created: ${jiraUrl}`);
console.log(`Workflow: ${workflowName}`);
console.log(`Status: awaiting approval (move to "${wf.jira.approvedStatus}" to proceed)`);
