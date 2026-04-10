# Queries and Design Decisions

Questions and discussions that came up during implementation, kept for future reference.

## Can we use Claude -p instead of the interactive REPL?

Yes. The `/project:create-evidence-file` skill works via `./scripts/create-evidence-file.sh` which calls `claude -p` headlessly. The skill is a one-shot operation (create ticket, write state file) so there's no need for interactivity. The `--allowedTools` flags pre-authorize the tools Claude needs.

## Does the poller risk duplicate job runs at short poll intervals?

No. The state file acts as a lock — each poll advances the status one step (`awaiting_approval` → `approved` → `runbook_running` etc.), so even overlapping polls would see the updated status and skip. The poller is also single-threaded, so it can't overlap with itself. Poll intervals as low as 5 seconds are safe.

## What if a runbook fails?

The status is set to `runbook_failed` and the poller skips it on subsequent polls, logging "needs manual intervention." The error and full runbook output are posted as a Jira comment. To retry, delete the state file — the poller will re-discover the ticket from Jira and start fresh.

## Should parameters come from Jira labels or ticket summaries?

We started with label prefixes (e.g., `keyword:myvalue`) but switched to summary-based extraction. Jira saves every unique label in its autocomplete history permanently, so parameter labels would pollute the suggestions with one-off values. Summary regex (e.g., `Create evidence file: myvalue`) keeps labels clean — one label per workflow type, parameters in the title.

## Do we actually need Claude to create tickets?

No. The Claude skill creates a Jira ticket from a template and writes a state file — there's no reasoning or dynamic content involved. A plain Node.js script (`scripts/create-workflow-no-claude.js`) does the same thing instantly, deterministically, and for free. Claude is not guaranteed to be deterministic, so for templated operations the script is more reliable.

The Claude skill is worth keeping only if you want natural language input in the future (e.g., "create a change request for the nginx config update" and have Claude figure out which workflow and parameters to use).

## Could users just create tickets directly in Jira?

Yes. The poller scans Jira boards by label and discovers new tickets automatically. Users can create a ticket in the configured project, add the workflow label (e.g., `clautobot-evidence`), put the parameter in the summary, and the poller picks it up. No script or Claude needed.

## Does the poller scale with many workflow types?

Currently each workflow type is a separate JQL query per poll cycle. With 10-20 types this is fine — Jira Cloud rate limits are generous. If it ever became an issue (50+ types), the queries could be consolidated into a single JQL sweep:

```
labels in ("clautobot-evidence", "clautobot-config", ...) AND status = "To Do"
```

Then route tickets to workflow types by label. But the current approach is simpler and easier to debug — each workflow's discovery is independent. Optimise when it's actually a problem.

## What would a more evolved architecture look like?

The key insight is that the state machine is always the same (discover → approve → execute → close). What varies is config: which Jira board, which runbook, what parameters. So the system is driven by `workflows.yml` — adding a new workflow type is a YAML block plus an Octopus runbook. No code changes needed.

Future evolution paths:
- **Web dashboard** reading from state files for visibility
- **Jira webhooks** to replace polling with push notifications
- **Configurable workflow templates** for more complex approval chains
- **Consolidated JQL queries** if the number of workflow types grows large

## Should the dashboard let users create tickets directly?

Yes, short-term. The dashboard already knows all the workflow types and their parameter definitions from `workflows.yml`. A form per workflow type is straightforward — a POST endpoint that creates the Jira ticket and state file. This makes the dashboard the single interface for both monitoring and initiating workflows, so users don't need Jira bookmarks, CLI scripts, or knowledge of label conventions.

Long-term, this is the wrong place for ticket creation. See the next question.

## Should we use Jira Service Management (JSM) instead of building request forms?

Yes, for anything beyond personal/internal use. JSM already provides a request portal, forms with validation, approval workflows, SLAs, queue management, customer notifications, and a compliance-grade audit trail. Rebuilding any of that in a custom dashboard is a distraction from clautobot's real job.

The hybrid model is the right answer: **JSM is the frontend, clautobot is the audit and execution layer behind it.** JSM owns request creation, forms, approvals, customer comms. Clautobot owns polling JSM for approved requests, running runbooks, and giving the automation team operational visibility. Two audit trails with different audiences:

- **JSM audit** = compliance record (request came in, was approved by X at time T)
- **Clautobot audit** = automation record (poller picked up ticket at T1, started runbook at T2, runbook finished with exit code X at T3)

The current clautobot architecture is already set up for this. The poller doesn't care how tickets get created, only that they have the right label and approval status. Switching from manual creation to JSM Forms would only require pointing the JQL at the JSM project and adjusting `discovery.js` to start at the approved state instead of "To Do".

See `NEWPLATFORM.md` for the full plan.

## What changes when this becomes a team tool at real scale?

At 10 requests/day × 25 workflow types × new types added weekly:

- **Volume is trivial** — that's not the problem
- **Change velocity dominates** — new workflows weekly means config format and deployment flow matter more than throughput
- **Shared state** — JSON files on one laptop don't work; SQLite with an `audit_log` table gives real audit queries
- **Failure visibility** — failures need to appear in a dashboard, not an ssh session
- **Dashboard scales** — pagination, search, filters by workflow type / product / date / requester. The simple "show all" table breaks at ~3,500 records/year
- **Auth via reverse proxy** — never build auth into the app; use nginx/Caddy + oauth2-proxy against SSO. 30 minutes of setup vs weeks of writing auth code
- **Config split by product** — one YAML file per workflow, grouped by product folder, instead of one giant file

What you explicitly do NOT need at this scale: Kubernetes, message queues, event sourcing, Redis, GraphQL, a database server, rewriting in another language, microservices. Resist all of them.

## Do we need two audit trails (JSM and clautobot)?

Yes. They answer different questions and have different audiences:

- **JSM audit** is for compliance, management, and the requester's manager. "Was this request legitimate? Was it approved by the right person?"
- **Clautobot audit** is for the automation team. "What did the automation actually do? Did the runbook run once or twice? What was the output? Did the Jira comment that showed the result match what actually happened?"

Important scenarios where they diverge:
- Someone edits or deletes a clautobot-posted Jira comment — clautobot's log still shows what it actually did
- A runbook ran but the Jira transition failed — JSM says "pending," clautobot's log shows the runbook succeeded
- An auditor wants to know "what was automated" vs "what was manual" — you need the clautobot log to answer that

Neither replaces the other; together they tell the full story.
