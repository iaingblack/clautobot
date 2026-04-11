# JSM Plan: Password Reset via JSM → Clautobot → Octopus

> **Status**: approved, not yet implemented. First concrete slice of the target architecture described in [NEWPLATFORM.md](NEWPLATFORM.md).

## Context

Clautobot today discovers tickets via a flat `project + label + status="To Do"` JQL. [NEWPLATFORM.md](NEWPLATFORM.md) lays out a JSM-first target where JSM owns the form/approval UX and clautobot is reduced to "poll approved JSM requests → run the right Octopus runbook → close the ticket". Nothing from that target doc is implemented yet.

This plan delivers the **first concrete slice** of that target: a single JSM request type, `Password Reset`, with a required dropdown (`System-A` / `System-B`). The poller watches for approved Password Reset tickets and runs a different Octopus runbook per system. The form itself is explicitly out of scope — we get the request type wired end-to-end first, then add form fields later.

Success = create a Password Reset request in JSM, approve it, watch clautobot pick it up and run the correct runbook, see the Octopus link and runbook log posted back as a comment, ticket transitions to Done.

## Decisions locked in

- **Octopus layout**: the Octopus project and both runbooks already exist. The plan references them by name via placeholders (`<OCTOPUS_PROJECT>`, `<RUNBOOK_A>`, `<RUNBOOK_B>`) — fill in verbatim in `workflows.yml` at execution time. These are **not secrets** — credentials stay in `.env` (`OCTOPUS_API_KEY`, `JIRA_API_TOKEN`); `workflows.yml` only holds friendly identifiers that clautobot resolves to IDs via `resolveIds()` in [src/octopus.js](src/octopus.js).
- **JSM project**: reusing an existing JSM project. Part 1.1 (create project) is skipped. The user will provide the project key; the plan references it as `<JSM_PROJECT_KEY>`.
- **Discovery status**: switching discovery to `approvedStatus` globally, matching [NEWPLATFORM.md](NEWPLATFORM.md) line 209. The legacy `create-evidence-file` workflow will now discover at its configured `approvedStatus: "In Progress"` instead of the hardcoded `"To Do"`. This is a deliberate, one-line behavioural shift that aligns the whole codebase with the JSM target.

## Values the user needs to supply when executing

Not secrets — logical names only. Drop these into `workflows.yml` verbatim:

- `<JSM_PROJECT_KEY>` — e.g. `SD`, `ITSM`
- `<SYSTEM_CUSTOM_FIELD_ID>` — e.g. `customfield_10234`, discoverable via `GET /rest/api/3/field`
- `<APPROVED_STATUS_NAME>` — exact spelling from the JSM workflow, e.g. `Approved`
- `<OCTOPUS_SPACE>`, `<OCTOPUS_PROJECT>`, `<RUNBOOK_A>`, `<RUNBOOK_B>`, `<OCTOPUS_ENVIRONMENT>`

## Part 1 — JSM web UI setup (manual, one-time)

These are the exact clicks. Requires JSM project admin permissions on the target Jira Cloud instance.

### 1.1 Use the existing JSM project

Decision locked: reusing an existing JSM project. Capture its **project key** (visible in any issue URL `/browse/<KEY>-123` or in project settings) and use it as `<JSM_PROJECT_KEY>` throughout.

### 1.2 Create the "Password Reset" request type

- Project settings → **Request management** → **Request types** → **Create request type**
- Name: `Password Reset`
- Description: `Reset a user password on a specific system`
- Issue type: `Service Request` (the default — standard Jira issue under the hood, so JQL still works)
- Portal group: whichever matches your team layout (e.g. "Account & access")

### 1.3 Add the System dropdown

JSM needs a custom field for the System selection. Create it once at the Jira level, then add it to the request type:

- Jira settings (cog) → **Issues** → **Custom fields** → **Create custom field**
- Field type: **Select List (single choice)**
- Name: `System`
- Add two options: `System-A` and `System-B`
- Screens: add to the default screen for the JSM project's `Service Request` issue type
- Capture the field ID — after saving, the field's edit URL contains `customFieldId=10XXX`. We'll reference it as `customfield_10XXX` in the poller. Alternatively: `GET /rest/api/3/field` and grep for `"System"`.

Back in the request type editor:

- Open `Password Reset` → **Request form** / **Work item view** → add field → pick `System` → mark **Required**
- Save

### 1.4 Workflow / approved status

JSM's default IT workflow has an `Approval` / `Waiting for approval` stage. For clautobot's trigger we need a clearly named status that means "approved, go run it". Two options:

- Simplest: reuse the existing `Approved` status if the default workflow has one
- Otherwise: edit the workflow and add a status literally called `Approved` between `Waiting for approval` and `In Progress`

Capture the exact spelling — `workflows.yml` will reference it verbatim in both the JQL and the `approvedStatus` field.

### 1.5 Label each Password Reset request on creation

We still want a discovery label (cheap JQL, belt-and-braces against stale tickets from other request types). Two ways to get it there:

- **Automation rule** (recommended): Project settings → Automation → Create rule → Trigger: `Work item created`, Condition: `Request Type = Password Reset`, Action: `Add label clautobot-password-reset`
- **Manual**: add `clautobot-password-reset` as a default field value on the request type

### 1.6 Capture these values for `workflows.yml`

| Value | Where to find it | Used as |
|---|---|---|
| Project key | URL `/projects/<KEY>` | `jira.project` |
| `System` custom field ID | Custom field edit page or `/rest/api/3/field` | `customFieldFilter.field` |
| `approvedStatus` name | Workflow editor, exact spelling | `jira.approvedStatus` |
| Label | Set in 1.5 | `jira.label` |

## Part 2 — Code changes to the poller

Scope kept deliberately small. No database migration, no dashboard rewrite, no new param extraction strategy. Those are later phases from [NEWPLATFORM.md](NEWPLATFORM.md). We stay inside the current 1:1 workflow→runbook model by **creating two workflow entries** — one for System-A, one for System-B — each with its own JQL filter. This means:

- Zero new conditional logic in the state machine
- No new param extraction needed (the routing is in the JQL filter, not in ticket data)
- Adding a System-C later is copy-paste a third workflow entry

### 2.1 `workflows.yml` — add two entries

```yaml
  password-reset-system-a:
    description: "Password reset for System-A via JSM"
    jira:
      project: <JSM_PROJECT_KEY>
      label: clautobot-password-reset
      approvedStatus: <APPROVED_STATUS_NAME>
      requestType: "Password Reset"                    # NEW field, used in JQL
      customFieldFilter:                               # NEW field, narrows to System-A
        field: <SYSTEM_CUSTOM_FIELD_ID>
        value: "System-A"
    octopus:
      space: <OCTOPUS_SPACE>
      project: <OCTOPUS_PROJECT>
      runbook: <RUNBOOK_A>
      environment: <OCTOPUS_ENVIRONMENT>
    params: {}                                         # nothing dynamic for v1

  password-reset-system-b:
    description: "Password reset for System-B via JSM"
    jira:
      project: <JSM_PROJECT_KEY>
      label: clautobot-password-reset
      approvedStatus: <APPROVED_STATUS_NAME>
      requestType: "Password Reset"
      customFieldFilter:
        field: <SYSTEM_CUSTOM_FIELD_ID>
        value: "System-B"
    octopus:
      space: <OCTOPUS_SPACE>
      project: <OCTOPUS_PROJECT>
      runbook: <RUNBOOK_B>
      environment: <OCTOPUS_ENVIRONMENT>
    params: {}
```

### 2.2 [src/config.js](src/config.js) — accept new optional fields

At [src/config.js:19-21](src/config.js#L19-L21), extend validation so `requestType` and `customFieldFilter` are optional. Keep `project`, `approvedStatus` required. Make `label` optional (JSM-driven workflows may not need it, though in this plan we still use it).

If `customFieldFilter` is present, validate it has both `field` and `value`.

### 2.3 [src/discovery.js](src/discovery.js) — richer JQL, discover at approved state

Current JQL at [src/discovery.js:14](src/discovery.js#L14):

```js
const jql = `project = "${project}" AND labels = "${label}" AND status = "To Do"`;
```

Replace with a JQL builder that composes clauses from whatever is configured:

```js
const clauses = [`project = "${project}"`];
if (label) clauses.push(`labels = "${label}"`);
if (requestType) clauses.push(`"Request Type" = "${requestType}"`);
if (customFieldFilter) clauses.push(`"${customFieldFilter.field}" = "${customFieldFilter.value}"`);
clauses.push(`status = "${approvedStatus}"`);           // was hardcoded "To Do"
const jql = clauses.join(' AND ');
```

This aligns with [NEWPLATFORM.md](NEWPLATFORM.md) line 209 (discover at `Approved`, not `To Do`). Existing `create-evidence-file` workflow keeps working because its `approvedStatus: "In Progress"` just means we now discover tickets that are already in progress — a small behavioural shift for that legacy demo workflow; acceptable because the demo flow still runs end-to-end from an already-approved state.

### 2.4 State machine — no change required

Because `createWorkflow` sets status to `awaiting_approval` and [src/poller.js:40-49](src/poller.js#L40-L49) immediately checks if current Jira status matches `approvedStatus`, a freshly-discovered ticket flows `awaiting_approval → approved → runbook_running` over the course of the same or next poll. Wastes one cheap Jira round-trip — acceptable for the slice. Tidying this into a single step is a follow-up.

### 2.5 Nothing else needs to move

- [src/params.js](src/params.js) — untouched. `params: {}` is fine.
- [src/jira.js](src/jira.js) — untouched. Fetching only `status/summary/labels` is enough because the JQL-side filter handles the System routing; we don't need to read the custom field value from the ticket body at all for v1.
- [src/octopus.js](src/octopus.js) — untouched.
- [src/poller.js](src/poller.js) — untouched (state machine works as-is).
- [src/state.js](src/state.js) — untouched (still JSON files for this slice).

## Part 3 — Octopus prerequisites

Before the poller will run cleanly, the Octopus side needs:

- An Octopus project (name captured as `<OCTOPUS_PROJECT>`) in the configured space
- Two runbooks inside it: `<RUNBOOK_A>` and `<RUNBOOK_B>`
- Each runbook published to the target environment
- API key in `.env` already has runbook-execution rights (existing requirement)

For the first end-to-end test the runbooks can be trivial "Write-Host 'Reset for X'" placeholders — the point is to prove the wiring, not the action.

## Files touched

- `workflows.yml` — add two entries (Part 2.1)
- [src/config.js](src/config.js) — loosen required fields, validate new optional ones (Part 2.2)
- [src/discovery.js](src/discovery.js) — JQL builder + `approvedStatus` in discovery (Part 2.3)

Three files. No new files, no new dependencies.

## Verification

1. **JSM smoke**: open the JSM portal as a requester, submit a `Password Reset` request, pick `System-A`. Confirm the ticket appears in Jira with the label, Request Type, and custom field set correctly.
2. **JQL dry-run**: in Jira → Issues → advanced search, paste the JQL clautobot will use:
   `project = "<JSM_PROJECT_KEY>" AND labels = "clautobot-password-reset" AND "Request Type" = "Password Reset" AND "<SYSTEM_CUSTOM_FIELD_ID>" = "System-A" AND status = "<APPROVED_STATUS_NAME>"` — confirm it returns the ticket only after you move it through approval to the approved status.
3. **Poller**: `npm run poller`. Approve the ticket in JSM. Watch logs for `New ticket found: <KEY>-N (workflow: password-reset-system-a)` then the runbook task being triggered.
4. **Octopus**: confirm the matching runbook fired (System-A runbook for System-A selection, not System-B).
5. **Round-trip**: confirm a comment with the Octopus task URL + log lands on the JSM ticket, and the ticket transitions to `Done`.
6. **Negative path**: submit a System-B request, approve it, confirm `password-reset-system-b` fires and `password-reset-system-a` does not.
7. **Regression**: confirm `create-evidence-file` workflow still discovers and runs (may need to move a test evidence ticket into `In Progress` state directly, since discovery now requires `approvedStatus` rather than `To Do`).

## Explicit non-goals (to prevent scope creep)

- JSM **form** customisation beyond the single dropdown — form work comes later
- `jsm-field` parameter extraction strategy from [NEWPLATFORM.md](NEWPLATFORM.md) line 196 — not needed, routing is in the JQL filter
- SQLite migration, audit log table, dashboard rebuild — NEWPLATFORM phases 1/3
- Supporting multiple approval statuses per workflow — out of scope
- Retries, structured logging, health endpoint — NEWPLATFORM phase 5
