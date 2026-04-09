import { searchIssues } from './jira.js';
import { createWorkflow, getWorkflow } from './state.js';
import { extractParams } from './params.js';

/**
 * Discover new Jira tickets for a workflow type and create state files.
 *
 * @param {string} workflowName - key from workflows.yml
 * @param {object} workflowConfig - the workflow config object
 * @returns {string[]} ticket keys that were newly discovered
 */
export async function discoverTickets(workflowName, workflowConfig) {
  const { project, label } = workflowConfig.jira;
  const jql = `project = "${project}" AND labels = "${label}" AND status = "To Do"`;

  const issues = await searchIssues(jql);
  const discovered = [];

  for (const issue of issues) {
    // Skip if we already have a state file for this ticket
    try {
      await getWorkflow(issue.key);
      continue; // already tracked
    } catch {
      // no state file — this is a new ticket
    }

    const params = extractParams(issue, workflowConfig.params);
    const jiraUrl = `${process.env.JIRA_BASE_URL}/browse/${issue.key}`;

    await createWorkflow(issue.key, workflowName, params, jiraUrl);
    discovered.push(issue.key);
  }

  return discovered;
}
