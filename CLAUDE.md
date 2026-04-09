# Clautobot

Automated change management: a background poller watches Jira for approved tickets and triggers Octopus Deploy runbooks.

## Architecture

The **poller** (`npm run poller`) is the core. It runs unattended and handles the full lifecycle:
1. Discovers new Jira tickets matching workflow configs
2. Waits for approval (Jira status transition)
3. Triggers the configured Octopus Deploy runbook
4. Posts runbook output to the Jira ticket
5. Closes the ticket on completion

Workflow types are defined in `workflows.yml`. Adding a new type requires no code changes.

Optional: Claude skill and CLI script can also create tickets, but users can just create them directly in Jira with the right label.

## Project Structure

- `workflows.yml` - Workflow type definitions (Jira project, Octopus runbook, parameters)
- `src/poller.js` - Background service entry point
- `src/config.js` - Loads and validates `workflows.yml`
- `src/discovery.js` - Jira-driven ticket discovery (JQL scan per workflow type)
- `src/params.js` - Parameter extraction from Jira tickets (labels, summary, custom fields)
- `src/jira.js` - Jira Cloud REST API client
- `src/octopus.js` - Octopus Deploy REST API client
- `src/state.js` - Workflow state management (JSON files in `state/`)
- `.claude/commands/create-evidence-file.md` - Optional Claude skill
- `scripts/create-evidence-file.sh` - Optional CLI wrapper

## Configuration

Credentials in `.env` (see `.env.example`). Never commit secrets.

Required environment variables:
- `OCTOPUS_SERVER_URL` - Local Octopus Deploy server URL
- `OCTOPUS_API_KEY` - Octopus API key with runbook execution permissions
- `JIRA_BASE_URL` - Jira Cloud instance URL
- `JIRA_EMAIL` - Jira account email for API auth
- `JIRA_API_TOKEN` - Jira API token
- `POLL_INTERVAL_SECONDS` - How often to poll (default: 300)

Workflow-specific config (Jira project, Octopus space/project/runbook, parameters) lives in `workflows.yml`.

## workflows.yml Format

```yaml
workflows:
  workflow-name:
    description: "What this workflow does"
    jira:
      project: PRO          # Jira project key
      label: clautobot-xxx   # Label that identifies tickets for this workflow
      approvedStatus: "In Progress"  # Status that means approved
    octopus:
      space: Default
      project: MyProject
      runbook: My Runbook
      environment: Production
    params:
      ParamName:
        from: label-prefix   # extraction strategy
        prefix: "value:"     # strategy-specific config
```

### Parameter Extraction Strategies

- `label-prefix` - Extract from a Jira label: label `keyword:myvalue` with prefix `keyword:` gives `myvalue`
- `summary-regex` - Regex match on ticket summary: first capture group becomes the value
- `custom-field` - Read from a Jira custom field by field ID
- `fixed` - Hardcoded value

## Jira Workflow

- Tickets with the configured label and status "To Do" are discovered automatically
- Moving a ticket to the workflow's `approvedStatus` triggers the runbook
- On completion, the poller transitions the ticket to "Done"

## Workflow State

State files in `state/<TICKET-KEY>.json` track each workflow instance.

Status progression: `awaiting_approval` -> `approved` -> `runbook_running` -> `runbook_complete` -> `done`

If a runbook fails: `runbook_failed` (delete the state file to retry)

## Adding New Workflow Types

No code changes needed:
1. Add a block to `workflows.yml`
2. Create the Octopus Deploy runbook
3. Restart the poller

## Running

```bash
cp .env.example .env    # Fill in credentials
npm install
npm run poller          # Start the background service
```
