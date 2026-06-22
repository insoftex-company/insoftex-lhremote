---
name: lhremote-mcp
description: This skill should be used when the user asks about lhremote MCP tools, LinkedHelper automation workflows, campaign management, account selection, instance lifecycle, instance health/connectability, people collection, messaging, or any lhremote CLI/MCP commands. Provides tool discovery, instance/account visibility, lifecycle and stability patterns, workflow sequences, parameter conventions, error handling, and rate-limiting guidance for automating LinkedHelper via CDP.
version: 2.2.0
updated: 2026-06-22
---

# lhremote MCP — Tool Surface & Workflow Guide

This skill teaches lhremote MCP workflow patterns, conventions, and error handling for automating LinkedHelper (LH) via Chrome DevTools Protocol (CDP). It reflects lhremote **v0.22.0**, which adds reliable instance/account visibility, a stable instance-lifecycle path, and the `restart-instance` / `ensure-instances` / `list-orphans` / `reap-orphans` tools.

## Prerequisites

LinkedHelper must be installed locally with an active license per LinkedIn account. The MCP server connects via CDP. LinkedHelper runs as a **launcher** process plus, per started account, one **account-instance** process and a cluster of **Chromium helper child processes**.

## Tool Discovery

Tools are autodiscovered via the MCP protocol handshake (`tools/list`). After a Claude restart the tool surface re-initializes; if a tool reports "not found," re-discover before concluding it is missing.

---

## Instance & Account Visibility

This is the foundation for "which accounts are started?" — answer it with `check-status`, not by guessing from ports.

### Process model (how lhremote classifies LH processes)

- **Launcher** — single shared process; manages all instances; owns the launcher CDP port (dynamic, e.g. 9222 — never assume a fixed value).
- **Account-instance main process** — launched from `...\resources\out\linked-helper.exe`; its command line carries `--app-id`/`--user-li-id`/`--user-li`; has **no** `--type=` flag; listens on its own dynamic CDP port. This is the thing you start/stop/restart.
- **Helper children** — Chromium subprocesses with a `--type=` flag (`gpu-process`, `renderer`, `utility`, `crashpad-handler`). They never expose a CDP port and are **never** instances or orphans. Each is attributed to its parent (launcher or an instance main process) and collapsed into a `helperChildCount`.

### Identity resolution

Account identity (`accountId`, `name`, `email`) is parsed from the instance main process command line (`--app-id`/`--user-li-id`/`--user-li`) via process inspection. This works **even when the launcher CDP is down** (`source: "cmdline"`, `confidence: "high"`).

- **Decoy field:** the command line also carries `--lh-account`, which is the **license owner** and is identical across all instances. Never use it for per-instance identity.
- **Security:** identity parsing uses a strict allowlist. Credentials (`--app-credentials`), proxy (`--upstream-proxy`), and Sentry DSN are never captured, logged, or surfaced.

### `check-status` — authoritative running state

Returns:
- `launcher: { reachable, port }`
- `runningInstances[]` — the genuinely running set (process-inspected, launcher-independent). Each: `{ accountId, name, email, pid, cdpPort, connectable, readiness, helperChildCount, source, confidence }`.
- `databases[]` — all configured accounts (the full roster). Being in `databases` does **not** mean an instance is running.
- `warnings[]` — actionable notes (e.g. launcher unreachable).

Read the running set from `runningInstances[]`, not from `databases[]`. The number of running instances is typically smaller than the number of configured accounts.

### `find-app` — process/role view

Returns the launcher plus classified account instances (each with `accountId` and `helperChildCount`), connectable-first. Helper children are collapsed into counts by default. Use `find-app` for process/PID/port detail; use `check-status` for the account-level running set.

---

## Workflow Patterns

### Discovery Flow

Start here when connecting for the first time in a session:

```
find-app → check-status → list-accounts
```

- `find-app` — detect LH processes, launcher, and classified instances.
- `check-status` — authoritative running set + launcher health (fast; bypasses retry).
- `list-accounts` — full configured roster (a **launcher** op; needs the launcher reachable).

If `find-app` returns nothing, use `launch-app` first.

### Instance Lifecycle

An instance must be running before campaign/query operations:

```
launch-app → start-instance → [work] → stop-instance → quit-app
```

To recycle a single stuck instance, prefer `restart-instance` over a manual stop+start:

```
restart-instance(accountId)   # stop → wait for exit → start → wait until connectable → verify
```

To bring up a set of accounts safely, use `ensure-instances`:

```
ensure-instances(accountIds[])  # serialized starts + settle, skips already-running, verifies each
```

Key rules:
- `start-instance` auto-selects the account only when one exists; pass `accountId` when multiple are configured.
- Lifecycle ops (`start`/`stop`/`restart`/`launch`/`quit`, and `list-accounts`) are **launcher operations** — they go through the single shared launcher and require its CDP reachable. They are **serialized internally with settle barriers**; expect a brief launcher "wobble" during them that self-recovers (~30s).
- `restart-instance` and `stop-instance` affect **only the target account's process**. Other instances' processes and campaigns keep running; their CDP may blip briefly, then recovers.
- Confirm true state with `check-status` (process inspection) — **do not** trust the immediate `start`/`stop` return payload, which can report phantom/duplicate ports.

### Instance Connectability & Stability

**Connectability is eventually-consistent, not binary.** A just-started or momentarily-disrupted instance can report `connectable: false` for up to ~30s, then become connectable on its own. A single non-connectable read is **not** a failure.

- **Re-poll before concluding failure.** Poll `check-status` across the ~30s grace window. Only treat an instance as `stuck` if it stays non-connectable for the whole window. Use the `readiness` field (`connectable` / `starting` / `degraded` / `stuck`) when present.
- **Transient vs stuck.** `degraded` (transiently unreachable, within grace) → wait, do nothing. `stuck` (past grace) → `restart-instance(accountId)`.
- **Don't restart healthy instances.** Restarting a merely-transient instance is unnecessary and itself triggers launcher churn. Diagnose first.
- **Never rapid-fire `start-instance`.** Use `ensure-instances` (sets) or `restart-instance` (one) — they serialize and settle between operations. Back-to-back raw starts are the known cause of launcher CDP drops.
- **Reads are launcher-independent; writes are not.** `check-status`/`find-app`/`query-*` work even when the launcher CDP is down. `start`/`stop`/`restart`/`list-accounts` need the launcher reachable and auto-recover within ~30s; if a launcher op fails, retry after the recovery window rather than escalating.
- **Verify lifecycle results by re-poll.** After start/restart, confirm via `check-status` that the account is connectable on a distinct real port. An unlicensed or failed account produces **no** instance process — expect `failed`/`verified: false`, never a phantom "started".

### Orphan Management

- `list-orphans` — returns true orphans only: non-connectable instance-side processes not mapped to any live account. Helper children (`--type=`) are never orphans. In a healthy state this is empty.
- `reap-orphans` — terminates orphans; **dry-run by default**, requires `confirm: true`, and never touches connectable/mapped instances, the launcher, or helpers of a live parent.

### Collection Workflow (primary targeting)

```
[build search URL] → collect-people(campaignId, sourceUrl) → campaign-status → campaign-start
```

- `collect-people` accepts a LinkedIn page URL + campaign ID; source type auto-detected from the URL; runs asynchronously.
- Optional params: `limit`, `maxPages`, `pageSize`, `sourceType`, `accountId` (required with multiple accounts).
- Poll `campaign-status` for progress; start with `campaign-start` once enough people are collected.
- Only one collection runs at a time per instance (`CollectionBusyError` otherwise).

### Campaign Creation & Execution

```
describe-actions → campaign-create → [populate targets] → campaign-start → campaign-status / campaign-statistics
```

- Use `describe-actions` to get authoritative action config schemas before building a campaign.
- `campaign-create` accepts YAML (default) or JSON.
- Populate targets via `collect-people` (recommended), `import-people-from-collection`, or `import-people-from-urls` (use the CLI `--urls-file` for 1000+ URLs).
- `campaign-start` requires `campaignId` + `personIds` (internal IDs); returns immediately (async).
- Monitor with `campaign-status` (optional `includeResults`) and `campaign-statistics`.

> For campaign **design/validation** (action ordering, reply detection, webhook placement, Insoftex CRM rules), use the LinkedHelper campaign skill, not this file.

### Campaign Action Chain Management

`campaign-add-action`, `campaign-remove-action`, `campaign-reorder-actions`, `campaign-move-next`.

### Lists Management

```
create-collection → add-people-to-collection → import-people-from-collection → [reuse across campaigns]
```

`list-collections`, `delete-collection`, `remove-people-from-collection`. Adding an already-present person is idempotent.

### Messaging Workflow

```
check-replies → query-messages
```

`scrape-messaging-history` does a full scrape. `query-messages` filters by `personId`, `chatId`, or `search`.

### Data Queries (instance required, no campaign)

`query-profile` (by `personId` or `publicId`), `query-profiles` (by name/headline/company with pagination). `campaign-list` connects via CDP and requires a running instance; it lists campaigns for the resolved account — pass `accountId` with multiple accounts.

---

## Parameter Conventions

- **`accountId`** — required for campaign/targeting/import/lifecycle tools when multiple accounts are configured; auto-resolved only with a single account.
- **`cdpPort`** — optional; auto-discovered from running LH processes. Ports are **dynamic** — never hardcode.
- **`cdpHost` / `allowRemote`** — default loopback (`127.0.0.1`). `allowRemote` enables non-loopback CDP (remote code execution risk) — only on a secured network path.
- **`campaignId` / `actionId` / `personId`** — internal LH integer IDs (not LinkedIn public IDs).
- **`publicId`** — LinkedIn URL slug (e.g. `jane-doe-12345`).
- **`format`** — campaign config `"yaml"` (default) or `"json"`.
- **lifecycle timings** (v0.22.0) — grace window, `waitForConnectable` timeout/interval/backoff, settle-barrier timeout, inspection cache TTL, launcher-recovery cap are configurable with sane defaults derived from the observed ~30s launcher-recovery window; tune empirically.

## Startup & Launcher Timing on Windows

- After `launch-app`, LH briefly drops its CDP port while reconnecting; CDP-auto-discovery commands retry up to ~30s. This is expected.
- Lifecycle ops are serialized with settle barriers; a launcher CDP drop during them auto-recovers within ~30s.
- `check-status` intentionally bypasses retry for a fast health probe and remains correct even when the launcher is unreachable.

## Error Patterns

| Error / symptom | Cause | Fix |
|---|---|---|
| "No running LinkedHelper instances found" | App not running | `launch-app` |
| "LinkedHelper is running but CDP is not reachable" | LH up, launcher CDP not yet available | Auto-retries ~30s; if it persists, `launch-app --force` |
| "Instance not running" | Instance not started for account | `start-instance` (or `ensure-instances`) |
| "No accounts found" / "Multiple accounts" | Account resolution failed | `list-accounts`, then pass explicit `accountId` |
| "Campaign not found" | Invalid campaign ID | `campaign-list` for valid IDs |
| "Cannot collect — instance is busy" | Another collection in progress | Wait for it to finish, then retry |
| Instance started but **not connectable** | Transient — launcher churn or still initializing | Re-poll `check-status` for ~30s; usually self-recovers. Do not restart yet. |
| Instance non-connectable **past the ~30s grace window** | Genuinely stuck instance | `restart-instance <accountId>` — recycles only that instance; others keep running |
| `ensure-instances`/`start-instance` returns `verified: false` | Verification ran before the instance settled, or a phantom/duplicate port was reported | Confirm true state with `check-status`; the instance often is up. v0.22.0 verification polls until the grace window. |
| Launcher `reachable: false` during a lifecycle op | Launcher CDP dropped (often after rapid starts) | Lifecycle ops auto-recover within ~30s; retry after the window. Reads still work meanwhile. |
| Multiple `start-instance` calls report the **same** CDP port | Phantom/duplicate port; instances not yet distinctly bound | Ignore the payload port; read real ports from `check-status` once settled |
| Account requested but **no instance process** appears | Account has no LH license / failed to launch | Reported as `failed`/`verified: false`; verify the account's license — not a tooling error |

## Action Type Reference

Use `describe-actions` for full schemas. Types: `VisitAndExtract`, `InvitePerson`, `MessageToPerson`, `InMail`, `CheckForReplies`, `Follow`, `EndorseSkills`, `PersonPostsLiker`, `FilterContactsOutOfMyNetwork`, `RemoveFromFirstConnection`, `DataEnrichment`, `ScrapeMessagingHistory`, `Waiter`.

## Source Type Reference (`collect-people` auto-detects from URL)

**Free tier:** `SearchPage` (`/search/results/people/`), `MyConnections` (`/mynetwork/invite-connect/connections/`), `Alumni` (`/school/{id}/people/`), `OrganizationPeople` (`/company/{id}/people/`), `Group` (`/groups/{id}/members/`), `Event` (`/events/{id}/attendees/`), `LWVYPP` (`/me/profile-views/`), `SentInvitationPage`, `FollowersPage`, `FollowingPage`.
**Sales Navigator:** `SNSearchPage` (`/sales/search/people`), `SNListPage`, `SNOrgsPage` (`/sales/search/company`), `SNOrgsListsPage`.
**Recruiter:** `TSearchPage`, `TProjectPage`, `RSearchPage`, `RProjectPage`.

## Building LinkedIn Search URLs

Base: `https://www.linkedin.com/search/results/people/?` with `&key=value`. Faceted filters (except `keywords`/`firstName`/`lastName`/`title`) use URL-encoded JSON arrays (`[` → `%5B`, `]` → `%5D`, `"` → `%22`, `,` → `%2C`).

Key params: `keywords` (Boolean-capable), `network` (`F`/`S`/`O`), `geoUrn`, `currentCompany`, `pastCompany`, `school`, `industry`, `profileLanguage`, `title`, `connectionOf`.

Common geo URN IDs: US 103644278, Canada 101174742, UK 101165590, France 105015875, Germany 101282230, Spain 105646813, Italy 103350119, Netherlands 102890719, Switzerland 106693272, India 102713980, Australia 101452733, Brazil 106057199, Japan 101355337, SF Bay Area 90000084.

Discover other IDs via the LinkedIn URL bar after applying a filter, the company-page "See all jobs" `f_C=` trick, or the typeahead XHR in DevTools. LinkedIn caps search results at ~2,500 per query — split large targets into sub-queries. Sales Navigator uses the nested `query=(filters:List(...))` syntax (percent-encoded).

## Rate Limiting

- Campaign actions: 100–200 visits/day safe; start at 50/day and scale; cooldown ≥60s; set `cooldownMs` (60000–90000) and `maxActionsPerRun` (5–10).
- Collection: cap with `limit` (~1000/run) and `maxPages`; one collection per instance.
- LinkedIn warnings are far easier to prevent than to undo — start conservative.

## Common Pitfalls

| Pitfall | Correct approach |
|---|---|
| Reading the running set from `databases[]` / the account roster | Use `runningInstances[]` from `check-status` — that is the true running set |
| Judging instance health on a single `connectable` read | Connectability is eventually-consistent; re-poll across the ~30s grace window |
| Restarting an instance that's just transiently unreachable | Diagnose `degraded` vs `stuck` first; only restart after the grace window |
| Raw back-to-back `start-instance` calls | Use `ensure-instances`/`restart-instance` — they serialize and settle, avoiding launcher drops |
| Trusting the `start-instance` port in its return payload | Confirm real ports via `check-status` after the instance settles |
| Treating `--lh-account` as the instance's account | It's the license owner (identical across instances); use `--app-id`/`--user-li-id` |
| Counting `--type=` helper processes as instances/orphans | Helpers are children of a live parent — never instances, never orphans |
| Hardcoding CDP ports | Re-derive from `find-app`/`check-status` each session — ports are dynamic |
| Blocking a status read on launcher health | Reads are launcher-independent; only lifecycle ops need the launcher |
| Bulk `import-people-from-urls` via MCP for large lists | Use the CLI with `--urls-file` for 1000+ URLs |
| Starting at maximum rate | Start at 50/day, scale after confirming no LinkedIn warnings |
