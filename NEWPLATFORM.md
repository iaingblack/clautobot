# Clautobot: Audit & Execution Layer Behind JSM

This document describes what clautobot becomes when it's deployed as a real internal tool for a team, rather than a prototype. It is the target architecture — the current repo is intentionally left as-is so it can be demoed. Nothing in this document is implemented yet.

> **First implementation slice:** see [JSM-PLAN.md](JSM-PLAN.md) — a focused plan to wire up a single `Password Reset` JSM request type with a `System-A` / `System-B` dropdown routing to two Octopus runbooks. Touches only `workflows.yml`, [src/config.js](src/config.js), and [src/discovery.js](src/discovery.js). Deliberately skips SQLite, dashboard rewrite, and the `jsm-field` param strategy — those are later phases from this document.

## The Reframing

The current prototype grew organically: it creates Jira tickets via Claude or a CLI script, polls Jira for approval, runs an Octopus runbook, and shows everything in a dashboard with forms for new requests. That's fine for a demo of "what if Claude orchestrated this," but it's wrong for an internal team tool at real scale.

At real scale (10 requests/day, 25 workflow types across 5 products, new types added weekly, multiple people on the team):

- **JSM already does the frontend parts.** Request portal, forms with validation, approval workflows, SLAs, queues, customer notifications, audit trails that compliance will accept. Rebuilding any of this is a waste of effort.
- **Clautobot's job is narrower and clearer.** Watch JSM for approved requests, execute the corresponding Octopus runbook, record what happened, give the automation team operational visibility. That's it.

This changes what the project is. It stops being a "change management tool" and becomes an **audit and execution layer that sits behind JSM**.

## The Split

```
Requesters              SRE / Automation Team
    |                           |
    v                           v
+-------+              +--------+---------+
|  JSM  |              |  Clautobot       |
|       |<-------------|  Dashboard       |
| Forms |    reads     |  (operations)    |
| Queue |              +--------+---------+
| SLAs  |                       |
|Approv |                       | polls + executes
+-------+                       v
    |                  +--------+---------+
    |                  |  Clautobot       |
    +----------------->|  Poller          |
          polls        |  (service)       |
                       +--------+---------+
                                |
                                v
                       +--------+---------+
                       |  Octopus Deploy  |
                       +------------------+
```

**JSM owns**: request creation, forms, validation, approvals, customer communications, SLAs, the request portal, the audit trail that goes to auditors.

**Clautobot owns**: polling JSM for approved requests, running runbooks, tracking execution state, showing the automation team what's in flight, recording what the automation actually did (separate from "what JSM says should happen").

Two audit trails, different audiences:

- **JSM audit** = compliance record: request came in, was approved by X at time T.
- **Clautobot audit** = automation record: poller picked up ticket at T1, started runbook at T2, runbook finished with exit code X at T3, logs attached.

Together they tell the full story. Neither replaces the other.

## What Clautobot Stops Being

- **No ticket creation in clautobot.** Users create requests in JSM. Removing this eliminates the auth problem (who can create tickets?), the user attribution problem, and the duplicate of JSM functionality.
- **No Claude skill for ticket creation.** Same reason. The skill can remain in a `legacy/` folder for demos, but it's not part of the production workflow.
- **No approval UI.** JSM's approval flow is the approval flow. Clautobot watches for the approved status and acts.
- **No request portal.** JSM is the portal.

## What Clautobot Is

### 1. A JSM-aware poller

Every poll interval:

- Query JSM for tickets in the **approved** state with clautobot labels, across all configured request types
- For each newly-seen ticket, create a local execution record
- For each in-flight record, advance its state: fetch Octopus task status, post updates back to the JSM ticket, close the ticket on success

The poller already does almost exactly this. The change is:

- Stop discovering tickets in `To Do` state — JSM handles the pre-approval lifecycle
- Start at the approved state — clautobot's job begins when JSM says "go"
- Close the JSM ticket with a structured comment (task link, log, exit status) — this is the handoff back to the user

### 2. An operations dashboard for the automation team

Not for requesters. Not a portal. A view for the 2–5 people who own the automation, answering:

- **What's running right now?** (queue view)
- **What failed and needs attention?** (failures view, with the runbook log and the JSM link)
- **What did the automation do last week?** (history, searchable by workflow type / product / date)
- **Is the poller healthy?** (last poll, success rate, error rate, queue depth)
- **What workflow types does it know about?** (config view from `workflows/` directory)

### 3. An audit log of automation actions

Separate from JSM's audit. Records every state transition the poller made:

```
2026-04-10T09:15:02Z  OPS-142  discovered        workflow: web-restart, product: web-frontend
2026-04-10T09:15:03Z  OPS-142  runbook_started   task: ServerTasks-9823
2026-04-10T09:15:47Z  OPS-142  runbook_complete  duration: 44s, success: true
2026-04-10T09:15:48Z  OPS-142  jira_closed       comment_id: 193847
```

This answers "what did the automation actually do?" independent of what JSM shows. Important when:

- Something went wrong and you need to correlate JSM state with real execution
- The automation posted a comment that got edited/deleted in JSM
- Investigating why a runbook ran twice or not at all
- Showing an auditor exactly what was automated vs what was manual

## Architecture Changes

### Storage: SQLite

JSON files were fine for demo. At 10/day × 25 workflow types with new types added weekly, they break down. SQLite gives:

- Queryable history ("all web-frontend restarts last week")
- Atomic state updates (no half-written files)
- One file to back up
- A real place for the audit_log table

Schema:

```sql
CREATE TABLE executions (
  ticket_key TEXT PRIMARY KEY,
  workflow_type TEXT NOT NULL,
  product TEXT NOT NULL,
  status TEXT NOT NULL,              -- discovered, runbook_running, runbook_complete, runbook_failed, closed
  params TEXT NOT NULL,              -- JSON
  jira_url TEXT NOT NULL,
  requested_by TEXT,                  -- from JSM
  approved_by TEXT,                   -- from JSM
  octopus_task_id TEXT,
  runbook_log TEXT,
  error_message TEXT,
  discovered_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_executions_status ON executions(status);
CREATE INDEX idx_executions_workflow_type ON executions(workflow_type);
CREATE INDEX idx_executions_product ON executions(product);
CREATE INDEX idx_executions_discovered_at ON executions(discovered_at);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_key TEXT NOT NULL,
  event_type TEXT NOT NULL,           -- discovered, runbook_started, runbook_complete, runbook_failed, jira_closed, error
  actor TEXT NOT NULL,                -- 'poller' or a user (for manual retries)
  details TEXT,                        -- JSON
  created_at TEXT NOT NULL
);

CREATE INDEX idx_audit_ticket ON audit_log(ticket_key);
CREATE INDEX idx_audit_created_at ON audit_log(created_at);
```

Note: the table is named `executions`, not `workflows`. An execution is one attempt to run one runbook for one JSM ticket. "Workflow" is the type definition in YAML. Keeping these names distinct avoids confusion later.

### Workflow config: `workflows/` directory

One YAML file per workflow type, grouped by product:

```
workflows/
├── _template.yml
├── web-frontend/
│   ├── restart-service.yml
│   ├── clear-cache.yml
│   └── ...
├── payments-api/
│   ├── ...
```

Each file:

```yaml
name: web-frontend-restart-service
product: web-frontend
description: "Restart the web frontend service"
owner: sre-team@example.com
jira:
  project: OPS
  requestTypeId: 42                   # JSM Request Type, optional
  label: clautobot-web-restart        # clautobot discovery label
  approvedStatus: "Approved"          # status that means "clautobot may proceed"
  closedStatus: "Done"                # status clautobot transitions to on success
octopus:
  space: Default
  project: WebFrontend
  runbook: Restart Service
  environment: Production
params:
  Environment:
    from: jsm-field                   # new: read from JSM custom field
    field: customfield_10042
    allowedValues: [prod, staging, dev]
```

New parameter source: `jsm-field` — read parameters directly from JSM custom fields. JSM Forms collect these cleanly at submission; clautobot just reads them when it discovers the ticket. Much better than regex-matching summaries.

### Poller: approved-state discovery

Current discovery JQL:

```
project = OPS AND labels = clautobot-web-restart AND status = "To Do"
```

New discovery JQL:

```
project = OPS AND labels = clautobot-web-restart AND status = "Approved"
```

Combined with tracking already-discovered tickets in SQLite:

- JSM owns everything up to and including approval
- Clautobot picks up at approved, executes, closes
- If someone reopens a closed ticket, clautobot ignores it (it's already in the executions table with `closed` status)
- If someone cancels a ticket during execution, clautobot notices on next status poll and aborts cleanly

### Dashboard: operations-focused, not user-facing

Routes:

```
/                          → in-flight queue (running, awaiting runbook status)
/failures                  → recent failures that need attention
/history                   → paginated searchable history
/execution/:key            → detail view (state + audit log + runbook output)
/products/:product         → filter by product
/workflows                 → loaded workflow types from config
/health                    → poller health
/api/...                   → JSON endpoints for external monitoring
```

No creation forms. No auth inside the app — put it behind a reverse proxy with SSO.

Header shows: poller status (last poll, polls today, failures today), loaded workflow count, link to JSM project.

### Deployment: process manager or container

Running `node src/poller.js` in a terminal doesn't work for a team tool. Options:

- **Simplest**: `pm2` with `pm2-logrotate`, running on a single VM. 30 minutes of setup.
- **Most production-credible**: Dockerfile + docker-compose, with a volume mount for the SQLite file and logs.
- **If you already use systemd**: systemd unit file.

Pick one. The poller + dashboard run in a single Node process, so there's only one thing to deploy and monitor.

### Authentication: reverse proxy

`nginx` or `Caddy` in front of the dashboard:

- Terminates TLS
- Authenticates via `oauth2-proxy` against Google Workspace / Okta / whatever you use
- Passes `X-Forwarded-User` header through

Clautobot trusts that header for displaying "last action by" on manual operations (e.g., retrying a failed execution). It does not make auth decisions itself. This is 30 minutes of configuration instead of weeks of writing auth code.

### Operational resilience

- **Structured logging** with `pino` to `logs/poller.log`, rotated by `pino-roll` or external tools
- **Retries with exponential backoff** on transient Jira/Octopus API failures (3 attempts, 1s/5s/15s)
- **Health endpoint** `/api/health` returns 200 only if poll completed within `2 × pollInterval`
- **Failure webhook** — optional Slack webhook URL in env; post a message when a runbook fails
- **Graceful shutdown** already exists; verify it doesn't leave executions in half-states
- **Idempotent discovery** — SQLite PRIMARY KEY on `ticket_key` means re-discovery is a no-op

## Changes to the Repo

### New files

- `src/db.js` — SQLite wrapper, schema, migrations
- `src/audit.js` — append-only audit log helper
- `src/logger.js` — pino structured logger
- `scripts/migrate-from-json.js` — one-time migration of existing state/*.json
- `scripts/validate-workflows.js` — config validation (for CI and pre-commit)
- `workflows/_template.yml` — documented example for new workflow types
- `Dockerfile` + `docker-compose.yml` — deployment
- `deployment/nginx.example.conf` — reverse proxy + SSO config
- `deployment/clautobot.service` — systemd unit example
- `DEPLOYMENT.md` — runbook for deploying and operating

### Modified files

- `src/state.js` — backed by SQLite, adds audit events to every transition
- `src/config.js` — loads `workflows/` directory recursively, validates against schema
- `src/discovery.js` — searches for `approvedStatus` instead of `To Do`; reads JSM custom fields
- `src/jira.js` — adds `getCustomFields` / richer issue fetch including requester/approver
- `src/poller.js` — uses pino, emits audit events, retries transient failures
- `src/web.js` — queue/failures/history split, pagination, search, no creation forms
- `src/params.js` — adds `jsm-field` extraction strategy
- `public/style.css` — updated for new layout
- `package.json` — adds `better-sqlite3`, `pino`, `pino-http`, optionally `zod` for config validation

### Removed or moved to `legacy/`

- `scripts/create-evidence-file.sh`
- `scripts/create-workflow-no-claude.js`
- `.claude/commands/create-evidence-file.md`
- Creation forms in `src/web.js`

JSM creates tickets; these are no longer the production path.

## Implementation Sequence

Build in phases so each phase leaves the system working end-to-end.

### Phase 1 — SQLite + audit log

- Add `better-sqlite3`, write `src/db.js` with schema
- Migrate `src/state.js` to SQLite behind the same function signatures
- Add `src/audit.js`, wire audit events into every state transition in `src/poller.js`
- Write migration script from `state/*.json`
- Verify: existing workflows continue to run end-to-end, audit log shows every transition

### Phase 2 — JSM-focused discovery

- Update `src/discovery.js` to query for `approvedStatus` instead of `To Do`
- Add `jsm-field` param extraction strategy in `src/params.js`
- Extend `src/jira.js` to fetch requester, approver, and custom fields
- Populate `requested_by` / `approved_by` in the executions table
- Verify: create a JSM ticket, approve it in JSM, watch clautobot pick it up and execute

### Phase 3 — Dashboard rebuild

- Split `/` into queue / failures / history
- Add pagination and search
- Remove creation forms and creation routes
- Add detail view that shows the audit log for each execution
- Verify: team can find any execution from last 30 days in under 10 seconds

### Phase 4 — Workflow config at scale

- Split `workflows.yml` into `workflows/{product}/{type}.yml`
- Update `src/config.js` to load recursively
- Write `scripts/validate-workflows.js`
- Add `workflows/_template.yml` with comments
- Verify: adding a new workflow is purely "copy template, edit, commit, restart poller"

### Phase 5 — Deployment and ops

- Write Dockerfile + docker-compose.yml
- Write nginx reverse proxy example with oauth2-proxy
- Replace `console.log` with pino structured logging
- Add retry logic with backoff in Jira and Octopus clients
- Add `/api/health` with meaningful 200/503 responses
- Write `DEPLOYMENT.md`
- Verify: deploy to a VM, run for a week, no manual intervention needed

## Explicitly Not In Scope

- **A request portal** — JSM is that
- **User authentication inside the app** — reverse proxy does that
- **Approval workflows inside the app** — JSM does that
- **Notifications to requesters** — JSM does that
- **SLAs, queues, customer comms** — JSM does that
- **A database server** — SQLite is enough at 10/day
- **A message queue** — polling is fine
- **Kubernetes** — single-node VM or container is fine
- **Event sourcing** — the `audit_log` table gives the benefit with a fraction of the complexity
- **An API for external systems** — the JSON endpoints are enough; add more only when something asks

## Caveat

This plan assumes JSM is available. If only regular Jira Cloud is available, most of the structure still works — you would lose JSM Forms and custom field collection, and parameters would go back to summary/label extraction. The audit and execution layer is identical either way.
