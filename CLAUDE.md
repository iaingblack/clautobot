# Clautobot

Automated change management: Claude creates Jira tickets, a background service monitors for approval and triggers Octopus Deploy runbooks.

## Architecture

Two components work together:

1. **Claude skill** (`/project:create-evidence-file <keyword>`) - Creates the Jira ticket and writes initial workflow state.
2. **Background poller** (`npm run poller`) - Runs unattended. Polls Jira for approval, triggers Octopus runbook, closes ticket on completion.

Shared state lives in `state/` as JSON files. Both components read/write these.

## Project Structure

- `src/jira.js` - Jira Cloud REST API client (create issues, check status, transition, comment)
- `src/octopus.js` - Octopus Deploy REST API client (resolve IDs, trigger runbook, check task)
- `src/state.js` - Workflow state management (read/write JSON files in `state/`)
- `src/poller.js` - Background service entry point
- `.claude/commands/create-evidence-file.md` - Claude skill that initiates workflows
- `scripts/` - Utility scripts if needed

## Configuration

All config via `.env` file (see `.env.example` for template). Never commit secrets.

Required environment variables:
- `OCTOPUS_SERVER_URL` - Local Octopus Deploy server URL
- `OCTOPUS_API_KEY` - Octopus API key with runbook execution permissions
- `OCTOPUS_SPACE_NAME`, `OCTOPUS_PROJECT_NAME`, `OCTOPUS_RUNBOOK_NAME`, `OCTOPUS_ENVIRONMENT_NAME`
- `JIRA_BASE_URL` - Jira Cloud instance URL (e.g., https://yoursite.atlassian.net)
- `JIRA_EMAIL` - Jira account email for API auth
- `JIRA_API_TOKEN` - Jira API token (not password)
- `JIRA_PROJECT_KEY` - Jira project key for change tickets
- `JIRA_APPROVED_STATUS` - Status name that means "approved" (e.g., "In Progress")

## Jira Workflow

- Tickets are created with status "To Do"
- Moving a ticket to the status defined by `JIRA_APPROVED_STATUS` = approved
- The poller detects this and triggers the Octopus runbook
- On completion, the poller transitions the ticket to "Done"

## Workflow State

State files in `state/<TICKET-KEY>.json` track each workflow instance.

Status progression: `awaiting_approval` -> `approved` -> `runbook_running` -> `runbook_complete` -> `done`

## MCP Servers

- **Atlassian** (plugin, already installed) - Used by the Claude skill to create Jira tickets
- **Octopus Deploy** (configured in `.mcp.json`) - Used for browsing spaces/projects/environments. Runbook execution goes through REST API because the MCP server doesn't support runbooks.

## Adding New Task Types

1. Create a new Claude skill in `.claude/commands/`
2. Add a workflow type field to the state file
3. Add a handler in `src/poller.js` for the new workflow type
4. Create the corresponding Octopus runbook

## Running

```bash
# Copy and fill in config
cp .env.example .env

# Start the background poller
npm run poller

# In Claude Code, initiate a workflow
/project:create-evidence-file <keyword>
```
