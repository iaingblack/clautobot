---
description: "Create an evidence file via change management workflow: creates Jira ticket, background poller handles approval monitoring, Octopus runbook execution, and ticket closure. Usage: /project:create-evidence-file <keyword>"
allowed-tools: ["Bash", "Read", "Write", "mcp__plugin_atlassian_atlassian__*"]
---

# Create Evidence File Workflow

You are initiating a change management workflow. A background poller service (`npm run poller`) handles everything after ticket creation.

## Instructions

1. **Parse the keyword** from `$ARGUMENTS`. If empty, ask the user for a keyword.

2. **Read configuration** from the `.env` file in the project root to get `JIRA_PROJECT_KEY`, `JIRA_BASE_URL`, and `JIRA_APPROVED_STATUS`.

3. **Create a Jira ticket** using the Atlassian MCP tools if available, otherwise use curl:
   - Project: the `JIRA_PROJECT_KEY` from .env
   - Type: Task
   - Summary: `Change Request: Create evidence file with keyword '${keyword}'`
   - Description: `Automated change request from clautobot. This will trigger an Octopus Deploy runbook to create an evidence file containing the keyword '${keyword}' on the target server. Once this ticket is approved (moved to '${JIRA_APPROVED_STATUS}' status), the runbook will execute automatically via the background poller service.`

4. **Add a comment** to the ticket: `Created by clautobot automation. Keyword: ${keyword}. The background poller will proceed when this ticket is moved to '${JIRA_APPROVED_STATUS}'.`

5. **Write the state file** to `state/${TICKET_KEY}.json`:
   ```json
   {
     "ticketKey": "<TICKET_KEY>",
     "keyword": "<keyword>",
     "status": "awaiting_approval",
     "jiraUrl": "<JIRA_BASE_URL>/browse/<TICKET_KEY>",
     "octopusTaskId": null,
     "createdAt": "<ISO timestamp>",
     "updatedAt": "<ISO timestamp>"
   }
   ```

6. **Report to the user**:
   - Jira ticket URL
   - Current status: awaiting approval
   - Remind them: "Move the ticket to '${JIRA_APPROVED_STATUS}' to approve. Make sure the background poller is running (`npm run poller`)."
