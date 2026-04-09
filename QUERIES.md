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
