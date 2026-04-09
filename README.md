# Clautobot

Automated change management: a background poller watches Jira boards for approved tickets and triggers Octopus Deploy runbooks.

## How It Works

1. Create a Jira ticket with the right label and summary (e.g., label `clautobot-evidence`, summary `Create evidence file: myvalue`)
2. The poller discovers the ticket and starts tracking it
3. Approve the ticket by moving it to the configured status (e.g., "In Progress")
4. The poller triggers the configured Octopus Deploy runbook with extracted parameters
5. On completion, the poller posts the runbook output to the ticket and closes it

Workflow types are defined in `workflows.yml`. Adding a new type requires no code changes.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure credentials

```bash
cp .env.example .env
```

Edit `.env` with your values:

| Variable | Description |
|----------|-------------|
| `OCTOPUS_SERVER_URL` | Your local Octopus Deploy server URL (e.g., `http://localhost:8080`) |
| `OCTOPUS_API_KEY` | Octopus API key with runbook execution permissions |
| `JIRA_BASE_URL` | Your Jira Cloud URL (e.g., `https://yoursite.atlassian.net`) |
| `JIRA_EMAIL` | Jira account email |
| `JIRA_API_TOKEN` | Jira API token ([create one here](https://id.atlassian.com/manage-profile/security/api-tokens)) |
| `POLL_INTERVAL_SECONDS` | How often to poll in seconds (default: 300) |

### 3. Configure workflows

Edit `workflows.yml` to define your workflow types:

```yaml
workflows:
  create-evidence-file:
    description: "Create an evidence file on the target server"
    jira:
      project: PRO                    # Jira project key
      label: clautobot-evidence       # Label that identifies tickets for this workflow
      approvedStatus: "In Progress"   # Jira status that means "approved"
    octopus:
      space: Default
      project: Evidence
      runbook: Create Evidence File
      environment: Production
    params:                           # Parameters passed to the Octopus runbook
      Keyword:
        from: summary-regex           # Extract from the ticket summary
        pattern: ":\\s*(.+)$"         # e.g., "Create evidence file: myvalue" → Keyword=myvalue
```

### 4. Create the Octopus Deploy runbook

Create a runbook in your Octopus project that:
- Accepts the parameters defined in your workflow config (e.g., `Keyword`)
- Runs a script step, e.g.:
  ```powershell
  "#{Keyword}" | Out-File -FilePath "C:\evidence\#{Keyword}.txt"
  ```
- Publish the runbook so it has a published snapshot

## Usage

### Start the poller

```bash
npm run poller
```

This runs continuously, discovering and processing workflows on each poll interval. Keep it running in a terminal or use a process manager like `pm2`.

### Create a change request

Create a Jira ticket in the configured project with:
- The workflow label (e.g., `clautobot-evidence`)
- A summary containing the parameter after a colon (e.g., `Create evidence file: myvalue`)
- Status: "To Do"

The poller will discover it on the next poll cycle.

Alternatively, use the CLI script:

```bash
./scripts/create-evidence-file.sh my-keyword
```

### Approve the change

Move the Jira ticket to the configured approved status. The poller will detect this and trigger the Octopus runbook.

### Monitor progress

The poller logs all state transitions to the console. Runbook output is posted as a comment on the Jira ticket.

## Adding a New Workflow Type

No code changes needed:

1. Add a block to `workflows.yml` with the Jira project, label, and Octopus runbook details
2. Create the Octopus Deploy runbook
3. Restart the poller

## Parameter Extraction

Parameters are extracted from Jira tickets and passed to Octopus runbooks. Supported strategies:

| Strategy | Config | Example |
|----------|--------|---------|
| `label-prefix` | `prefix: "keyword:"` | Label `keyword:myvalue` → `myvalue` |
| `summary-regex` | `pattern: ": (.+)$"` | Summary `Config change: nginx` → `nginx` |
| `custom-field` | `field: customfield_10042` | Custom field value |
| `fixed` | `value: "hardcoded"` | Static value |

## Workflow State

Each workflow is tracked as a JSON file in `state/`. Status progression:

```
awaiting_approval → approved → runbook_running → runbook_complete → done
```

If a runbook fails, the status becomes `runbook_failed`. Delete the state file to retry.

## Project Structure

```
workflows.yml     # Workflow type definitions

src/
├── poller.js     # Background service — discovers, processes, and completes workflows
├── config.js     # Loads and validates workflows.yml
├── discovery.js  # Jira-driven ticket discovery (JQL per workflow type)
├── params.js     # Parameter extraction from Jira tickets
├── jira.js       # Jira Cloud REST API client
├── octopus.js    # Octopus Deploy REST API client
└── state.js      # Workflow state management (JSON files)

state/            # Runtime workflow state files (gitignored)
```
