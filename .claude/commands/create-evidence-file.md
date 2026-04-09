---
description: "Create an evidence file via change management workflow: creates Jira ticket with the right label, background poller handles the rest. Usage: /project:create-evidence-file <keyword>"
allowed-tools: ["Bash", "Read", "Write", "mcp__plugin_atlassian_atlassian__*"]
---

# Create Evidence File Workflow

You are initiating a change management workflow. A background poller service (`npm run poller`) handles everything after ticket creation.

## Instructions

1. **Parse the keyword** from `$ARGUMENTS`. If empty, ask the user for a keyword.

2. **Read configuration** from `workflows.yml` in the project root to get the `create-evidence-file` workflow config (Jira project, label, approvedStatus). Read `.env` for `JIRA_BASE_URL`.

3. **Create a Jira ticket** using the Atlassian MCP tools if available, otherwise use curl:
   - Project: the `jira.project` from workflows.yml (e.g., `EV`)
   - Type: Task
   - Summary: `Create evidence file: ${keyword}`
   - Description: `Automated change request from clautobot. This will trigger an Octopus Deploy runbook to create an evidence file containing the keyword '${keyword}' on the target server. Once this ticket is approved (moved to '${approvedStatus}' status), the runbook will execute automatically via the background poller service.`
   - Labels: the `jira.label` from workflows.yml (e.g., `clautobot-evidence`)

4. **Add a comment** to the ticket: `Created by clautobot automation. The background poller will proceed when this ticket is moved to '${approvedStatus}'.`

5. **Write the state file** to `state/${TICKET_KEY}.json`:
   ```json
   {
     "ticketKey": "<TICKET_KEY>",
     "workflowType": "create-evidence-file",
     "status": "awaiting_approval",
     "params": { "Keyword": "<keyword>" },
     "jiraUrl": "<JIRA_BASE_URL>/browse/<TICKET_KEY>",
     "octopusTaskId": null,
     "runbookLog": null,
     "createdAt": "<ISO timestamp>",
     "updatedAt": "<ISO timestamp>"
   }
   ```

6. **Report to the user**:
   - Jira ticket URL
   - Current status: awaiting approval
   - Remind them: "Move the ticket to '${approvedStatus}' to approve. Make sure the background poller is running (`npm run poller`)."
