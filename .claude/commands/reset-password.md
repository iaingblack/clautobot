---
description: "Validate and create a Jira change request to reset an admin password for a product. Usage: /reset-password <product> <environment>"
allowed-tools: ["Bash", "Read", "Write", "mcp__plugin_atlassian_atlassian__*", "mcp__octopus-deploy__*"]
---

# Reset Password Workflow

You are initiating a conversational change management workflow. The background poller (`npm run poller`) runs the Octopus runbook after the Jira ticket is approved. Your job here is to **validate and create the ticket** — not to run anything on Octopus yourself.

## Inputs

Parse `product` and `environment` from `$ARGUMENTS` (e.g. `/reset-password payments staging`) or from the free-text chat message that triggered this skill. If either is missing, ask the user. Treat `environment` as case-insensitive and normalize to lowercase.

## Safety defaults

- `environment` must be one of: `dev`, `staging`, `prod`.
- If `environment` is `prod`, explicitly confirm in your reply that this is a production change and surface it clearly — do not try to block it, but make sure the user sees it.

## Instructions

Perform these steps **in order**. If any validation step fails, STOP and explain — do not create the Jira ticket.

### 1. Load the workflow config

Read `workflows.yml`. Find the block named `reset-password-${product}` (e.g. `reset-password-payments`). Pull out: `jira.project`, `jira.label`, `jira.approvedStatus`, `octopus.space`, `octopus.project`, `octopus.runbook`, `octopus.environment`.

If no block exists for that product, STOP and list the available `reset-password-*` workflow names from the config so the user can pick one.

### 2. Validate against Octopus (read-only)

Call each of these tools and paste the relevant summary back into your reply so the user can see the validation actually ran:

1. `mcp__octopus-deploy__list_spaces` — confirm the configured `octopus.space` exists.
2. `mcp__octopus-deploy__list_projects` with the space ID — confirm the configured `octopus.project` exists.
3. `mcp__octopus-deploy__list_environments` — confirm the configured `octopus.environment` exists.
4. `mcp__octopus-deploy__get_deployment_process` for the project (runbooks surface here) — confirm `octopus.runbook` is one of the runbook names.

If any of these fail to find the expected item, STOP and report exactly which one was missing. Do not proceed to ticket creation.

### 3. Create the Jira ticket

Use `mcp__plugin_atlassian_atlassian__createJiraIssue` (or curl to `/rest/api/3/issue` with the env creds if the MCP tool is unavailable).

- Project: the `jira.project` from config
- Type: `Task`
- Summary: `Reset password: ${product} ${environment}`
- Labels: `[${jira.label}, env:${environment}, product:${product}]` — the poller reads these labels via `label-prefix` param extraction.
- Description: summarize: automated request from clautobot chat, the validation results, and the sentence "Once this ticket is moved to '${approvedStatus}', the runbook '${octopus.runbook}' will execute automatically via the background poller service."

Capture the returned ticket key (e.g. `EV-42`) and URL (`${JIRA_BASE_URL}/browse/${TICKET_KEY}`).

### 4. Comment on the ticket

Use `mcp__plugin_atlassian_atlassian__addCommentToJiraIssue` with:
`Created from clautobot chat (Claude). Validation passed for space/project/runbook/environment. The background poller will trigger the runbook when this ticket is moved to "${approvedStatus}".`

### 5. Write the state file

Write `state/${TICKET_KEY}.json`:

```json
{
  "ticketKey": "<TICKET_KEY>",
  "workflowType": "reset-password-${product}",
  "status": "awaiting_approval",
  "params": { "Environment": "${environment}", "Product": "${product}" },
  "jiraUrl": "<JIRA_URL>",
  "octopusTaskId": null,
  "runbookLog": null,
  "createdAt": "<ISO timestamp>",
  "updatedAt": "<ISO timestamp>"
}
```

### 6. Report back

Tell the user, in one concise paragraph:
- What you validated (space, project, runbook, environment — checkmark each)
- The Jira ticket URL and key
- What happens next: "Move to `${approvedStatus}` in Jira to run the runbook."
- If environment is `prod`, start the reply with `**PRODUCTION CHANGE**` on its own line.

Do **not** run the runbook yourself. The poller owns execution.
