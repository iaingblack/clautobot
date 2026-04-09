# Clautobot

Automated change management workflow that connects Jira Cloud and Octopus Deploy through Claude Code.

## How It Works

1. You run `./scripts/create-evidence-file.sh <keyword>` from the command line
2. Claude (via `claude -p`) creates a Jira ticket and saves workflow state
3. A background poller service watches for ticket approval
4. When the ticket is moved to the approved status, the poller triggers an Octopus Deploy runbook
5. On completion, the poller closes the Jira ticket

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your values:

| Variable | Description |
|----------|-------------|
| `OCTOPUS_SERVER_URL` | Your local Octopus Deploy server URL (e.g., `http://localhost:8080`) |
| `OCTOPUS_API_KEY` | Octopus API key with runbook execution permissions |
| `OCTOPUS_SPACE_NAME` | Octopus space (e.g., `Default`) |
| `OCTOPUS_PROJECT_NAME` | Octopus project containing the runbook |
| `OCTOPUS_RUNBOOK_NAME` | Name of the runbook to execute |
| `OCTOPUS_ENVIRONMENT_NAME` | Target environment for the runbook |
| `JIRA_BASE_URL` | Your Jira Cloud URL (e.g., `https://yoursite.atlassian.net`) |
| `JIRA_EMAIL` | Jira account email |
| `JIRA_API_TOKEN` | Jira API token ([create one here](https://id.atlassian.com/manage-profile/security/api-tokens)) |
| `JIRA_PROJECT_KEY` | Jira project key for change tickets |
| `JIRA_APPROVED_STATUS` | Jira status that means "approved" (e.g., `In Progress`) |

### 3. Create the Octopus Deploy runbook

Create a runbook in your Octopus project that:
- Has a prompted variable called `Keyword`
- Runs a script step that creates a file using the keyword, e.g.:
  ```powershell
  "#{Keyword}" | Out-File -FilePath "C:\evidence\#{Keyword}.txt"
  ```
- Publish the runbook so it has a published snapshot

### 4. Authenticate the Atlassian MCP plugin

Open Claude Code in this project and let it run the Atlassian OAuth flow. This is needed for the Claude skill to create tickets via MCP tools.

## Usage

### Start the background poller

```bash
npm run poller
```

This runs continuously, checking for workflow state changes every 5 minutes. Keep it running in a terminal or use a process manager like `pm2`.

### Initiate a workflow

```bash
./scripts/create-evidence-file.sh my-keyword
```

This runs Claude headlessly via `claude -p`, creates a Jira ticket, and saves a state file. The poller handles everything from there.

### Approve the change

Go to Jira and move the ticket to your configured approved status (e.g., "In Progress"). The poller will detect this within 5 minutes and trigger the Octopus runbook.

## Workflow State

Each workflow is tracked as a JSON file in `state/`. Status progression:

```
awaiting_approval → approved → runbook_running → runbook_complete → done
```

If a runbook fails, the status becomes `runbook_failed` and requires manual intervention.

## Project Structure

```
src/
├── poller.js     # Background service — polls Jira, triggers Octopus, closes tickets
├── jira.js       # Jira Cloud REST API client
├── octopus.js    # Octopus Deploy REST API client
└── state.js      # Workflow state management (JSON files)

.claude/commands/
└── create-evidence-file.md   # Claude skill that initiates workflows

scripts/
└── create-evidence-file.sh   # CLI wrapper for headless execution via claude -p

state/            # Runtime workflow state files (gitignored)
```
