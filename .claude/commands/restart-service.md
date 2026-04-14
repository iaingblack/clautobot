---
description: "Validate and create a Jira change request to restart a service for a product. Usage: /restart-service <product> <environment>"
allowed-tools: ["Bash", "Read", "Write", "mcp__plugin_atlassian_atlassian__*", "mcp__octopus-deploy__*"]
---

# Restart Service Workflow

You are initiating a conversational change management workflow. The background poller (`npm run poller`) runs the Octopus runbook after the Jira ticket is approved. Your job here is to **validate and create the ticket** — not to run anything on Octopus yourself.

## Inputs

Parse `product` and `environment` from `$ARGUMENTS` (e.g. `/restart-service web-frontend prod`) or from the free-text chat message. If either is missing, ask the user. Normalize `environment` to lowercase.

## Safety defaults

- `environment` must be one of: `dev`, `staging`, `prod`.
- Restarting a service in `prod` is user-visible. If environment is `prod`, start your reply with `**PRODUCTION RESTART**` on its own line so the user can't miss it.

## Instructions

Perform these steps **in order**. If any validation step fails, STOP and explain — do not create the Jira ticket.

### 1. Load the workflow config

Read `workflows.yml`. Find the block named `restart-service-${product}` (e.g. `restart-service-web-frontend`). Pull out the full `jira` and `octopus` sections.

If no block exists for that product, STOP and list the available `restart-service-*` workflow names from the config.

### 2. Validate against Octopus (read-only)

Call each of these tools and paste the relevant summary back into your reply:

1. `mcp__octopus-deploy__list_spaces` — confirm `octopus.space` exists.
2. `mcp__octopus-deploy__list_projects` with the space ID — confirm `octopus.project` exists.
3. `mcp__octopus-deploy__list_environments` — confirm `octopus.environment` matches the requested `environment` AND is a valid environment in Octopus.
4. `mcp__octopus-deploy__get_deployment_process` for the project — confirm `octopus.runbook` is one of the runbook names.

If the user-requested environment does not match the workflow's configured environment, STOP and report the mismatch. Do not guess or override.

### 3. Create the Jira ticket

Use `mcp__plugin_atlassian_atlassian__createJiraIssue` (or curl fallback).

- Project: the `jira.project` from config
- Type: `Task`
- Summary: `Restart service: ${product} ${environment}`
- Labels: `[${jira.label}, env:${environment}, product:${product}]`
- Description: short summary, the validation results, and "Once approved (moved to '${approvedStatus}'), the runbook '${octopus.runbook}' runs automatically."

Capture the returned ticket key and URL.

### 4. Comment on the ticket

Post a comment: `Created from clautobot chat (Claude). Validation passed. Poller will trigger runbook on approval.`

### 5. Write the state file

Write `state/${TICKET_KEY}.json` with the shape used by `reset-password.md`, using `workflowType: "restart-service-${product}"`.

### 6. Report back

Give the user a concise summary: what was validated, the ticket URL/key, next steps, and the `**PRODUCTION RESTART**` prefix if applicable.

Do **not** trigger the runbook yourself — the poller owns execution.
