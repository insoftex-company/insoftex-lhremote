---
name: lhremote-mcp
description: This skill should be used when the user asks about lhremote MCP tools, LinkedHelper automation workflows, campaign management, account selection, instance lifecycle, instance health/connectability, CDP port discovery, people collection, messaging, or any lhremote CLI/MCP commands. Provides tool discovery, instance/account visibility, the CDP connection/port model, lifecycle and stability patterns, Windows auto-start behavior, workflow sequences, parameter conventions, error handling, diagnostics, and resource/rate guidance for automating LinkedHelper via CDP.
version: 0.23.2
updated: 2026-06-24
---

# lhremote MCP — Tool Surface & Workflow Guide

This skill teaches lhremote MCP workflow patterns, conventions, and error handling for automating LinkedHelper (LH) via Chrome DevTools Protocol (CDP).

It reflects the Insoftex **dev fork** of lhremote, including the **CDP port-validation fix** (validated 2026-06-24) that resolved intermittent false "CDP not reachable" failures on launcher operations. Set the exact fork version string in your deployment notes; the behavioral baseline below assumes that fix is present.

## Prerequisites

LinkedHelper must be installed locally with an active license per LinkedIn account. The MCP server connects via CDP. LinkedHelper runs as a **launcher** process plus, per started account, one **account-instance** process and a cluster of **Chromium helper child processes**.

---

## CDP Connection Model & Port Discovery

This section is the foundation for understanding every "is it reachable?" question. Read it before trusting or doubting any reachability result.

### Each LH process binds TWO listening sockets

A running launcher (and each running instance) opens **two** listening TCP sockets at once:

- the **real CDP/DevTools endpoint** — the port that answers `http://127.0.0.1:<port>/json/version`;
- a **secondary ephemeral socket** the same Chromium/Electron process also opens, which does **not** speak CDP.

Observed examples (from process inspection):

```
launcher  PID 12548  --remote-debugging-port=9222  listening=[9222, 51664]
instance  PID 9852   (--remote-debugging-port=0)    listening=[52805, 64038]
```

Here `9222`/`52805` are the CDP ports; `51664`/`64038` are the non-CDP secondary sockets.

### The correct way to identify a CDP port

A CDP port is **only** confirmed by a successful `/json/version` probe — never by "this PID has a listening socket." Enumerating listening sockets and picking one without validation is how the historical discovery bug arose (it sometimes latched onto the secondary socket, e.g. `51664`, and falsely reported the launcher unreachable while `9222` was serving the whole time).

The current fork validates candidate ports via `/json/version` before accepting them and pins the validated port. With the fix in place:

- `check-status` reports `launcher.reachable` from the **same validated probe** used for the per-process detail — the summary and the `processes[]` detail no longer contradict each other.
- `start-instance` reports `… — verified` (not `NOT verified — duplicate port suspected`) and the reported instance port matches `check-status` immediately after.

### Regression signals (if the discovery bug ever returns)

Treat any of these as a discovery regression, not a real outage:

- A launcher op fails with "CDP is not reachable" while `/json/version` on the expected port (e.g. 9222) answers fine.
- `check-status` summary says `reachable: false` while its own `processes[]` entry for the same launcher PID shows `connectable: true`.
- The same launcher PID is reported on different ports across consecutive calls (e.g. 9222 then 51664).

Confirm with the **Diagnostic Recipes** below, then fall back to the explicit-port escape hatch.

### Explicit-port escape hatch

Every lifecycle/launcher tool accepts an explicit `cdpPort`. Passing it bypasses auto-discovery entirely:

```
start-instance(accountId, cdpPort: 9222)
stop-instance(accountId, cdpPort: 9222)
launch-app(cdpPort: 9222, force: true)   # pin a known port on relaunch
```

With the fix present you should **not** need this for normal operation. Keep it as a deterministic override for debugging or if a regression appears. Note: `9222` is only the right value when LH was started by the auto-start script (or `launch-app cdpPort: 9222`); a plain `launch-app force:true` picks a **new** dynamic port.

---

## Windows Auto-Start & Boot Behavior

Knowing exactly how LH comes up after a reboot is required to plan remote management.

### What auto-starts, and what does not

- The **launcher auto-starts** at Windows sign-in via a Startup-folder shortcut chain.
- **Account instances do NOT auto-start.** This is expected and acceptable. Instances are started on demand with `start-instance` / `ensure-instances` and stopped when idle.

### Auto-start chain (reference deployment)

```
Startup shortcut
  → C:\Users\xuser\scripts\launch-linkedhelper-silent.vbs   (runs the .cmd hidden)
    → C:\Users\xuser\scripts\launch-linkedhelper-silent.cmd
```

The silent `.cmd` is the one that actually runs at sign-in. It:

1. launches `linked-helper.exe --remote-debugging-port=9222`;
2. validates readiness the correct way — polling `http://127.0.0.1:9222/json/version`;
3. if LH is already running **without** CDP (stale non-debug instance), force-kills it and relaunches with the flag (mirrors `launch-app --force`);
4. waits up to 60s and logs to `%TEMP%\lh-cdp-startup.log`.

A verbose, interactive variant (`launch-linkedhelper.cmd`, with `pause`/echo) exists for manual runs. The boot log line to look for:

```
[<date> <time>] Launching with --remote-debugging-port=9222
[<date> <time>] CDP up after N check(s)
```

### Timing reality (measured)

- **Launcher CDP comes up in ~4s** after launch. There is no slow launcher warm-up. If launcher ops fail right after boot, suspect a discovery regression, not warm-up.
- **Instance startup is genuinely slow: ~35–90s** from spawn to `connectable` (webview load + LinkedIn sign-in). Budget ~1–1.5 min per instance start. Do **not** shorten this wait.

---

## Instance & Account Visibility

Answer "which accounts are started?" with `check-status`, not by guessing from ports.

### Process model (how lhremote classifies LH processes)

- **Launcher** — single shared process; manages all instances; owns the launcher CDP port (dynamic — e.g. 9222 from the startup script, or auto-selected). Binds CDP + a secondary socket (see CDP model above).
- **Account-instance main process** — launched from `…\resources\out\linked-helper.exe`; its command line carries `--app-id`/`--user-li-id`/`--user-li`; has **no** `--type=` flag; listens on its own dynamic CDP port (plus a secondary socket). This is the thing you start/stop/restart.
- **Helper children** — Chromium subprocesses with a `--type=` flag (`gpu-process`, `renderer`, `utility`, `crashpad-handler`). They never expose a CDP port and are **never** instances or orphans. Each is attributed to its parent and collapsed into `helperChildCount` (typically ~12 per running instance).

### Identity resolution

Account identity (`accountId`, `name`, `email`) is parsed from the instance main process command line (`--app-id`/`--user-li-id`/`--user-li`) via process inspection. This works **even when the launcher CDP is down** (`source: "cmdline"`, `confidence: "high"`).

- **Decoy field:** the command line also carries `--lh-account`, the **license owner**, identical across all instances. Never use it for per-instance identity.
- **Security:** identity parsing uses a strict allowlist. Credentials (`--app-credentials`), proxy (`--upstream-proxy`), and Sentry DSN are never captured, logged, or surfaced.

### `check-status` — authoritative running state

Returns:
- `launcher: { reachable, port }` — derived from a validated `/json/version` probe.
- `runningInstances[]` — the genuinely running set (process-inspected, launcher-independent). Each: `{ accountId, name, email, pid, cdpPort, connectable, readiness, helperChildCount, source, confidence }`.
- `databases[]` — all configured accounts (the full roster). Being in `databases` does **not** mean an instance is running.
- `warnings[]` — actionable notes (e.g. "LinkedHelper is not running.", launcher unreachable).

Read the running set from `runningInstances[]`, not from `databases[]`. The number running is typically smaller than the number configured.

### `find-app` — process/role view

Returns the launcher plus classified account instances (each with `accountId` and `helperChildCount`), connectable-first. Helper children are collapsed into counts. Use `find-app` for process/PID/port detail; use `check-status` for the account-level running set.

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

If `find-app` returns nothing / `check-status` warns "LinkedHelper is not running," use `launch-app` first.

### Instance Lifecycle

An instance must be running before campaign/query operations:

```
launch-app → start-instance → [work] → stop-instance → quit-app
```

Recycle a single stuck instance with `restart-instance` rather than manual stop+start:

```
restart-instance(accountId)   # stop → wait for exit → start → wait until connectable → verify
```

Bring up a set of accounts safely with `ensure-instances`:

```
ensure-instances(accountIds[])  # serialized starts + settle, skips already-running, verifies each
```

Key rules:
- `start-instance`/`stop-instance` auto-select the account only when one exists; pass `accountId` when multiple are configured.
- Lifecycle ops (`start`/`stop`/`restart`/`launch`/`quit`, and `list-accounts`) are **launcher operations** — they go through the launcher and require its CDP reachable. They are serialized internally with settle barriers; expect a brief launcher "wobble" that self-recovers.
- `restart-instance`/`stop-instance` affect **only the target account's process**. Other instances keep running.
- Confirm true state with `check-status` (process inspection) — do not trust the immediate `start`/`stop` return payload for port detail.
- These ops return `{ status:'in_progress', operationId }` when they take >2s. Poll `get-operation`; cancel with `cancel-operation`. Expect start ~35–90s, launch ~5–10s, stop ~10–60s.

### Instance Connectability & Stability

**Connectability is eventually-consistent.** A just-started or momentarily-disrupted instance can report `connectable: false` for up to ~30s, then become connectable on its own. A single non-connectable read is **not** a failure.

- **Re-poll before concluding failure.** Poll `check-status` across the grace window. Use the `readiness` field (`connectable` / `starting` / `degraded` / `stuck`) when present.
- **Transient vs stuck.** `degraded` (within grace) → wait. `stuck` (past grace) → `restart-instance(accountId)`.
- **Don't restart healthy instances.** Diagnose first; needless restarts trigger launcher churn.
- **Never rapid-fire `start-instance`.** Use `ensure-instances` (sets) or `restart-instance` (one) — they serialize and settle. Back-to-back raw starts are a known cause of launcher CDP drops.
- **Reads are launcher-independent; writes are not.** `check-status`/`find-app`/`query-*` work even when the launcher CDP is down. Lifecycle ops need the launcher and auto-recover within ~30s.
- **Verify lifecycle results by re-poll.** After start/restart, confirm via `check-status` that the account is connectable on a real port. An unlicensed/failed account produces **no** instance process — expect `failed`/`verified: false`, never a phantom "started."

### Orphan Management

- `list-orphans` — true orphans only: non-connectable instance-side processes not mapped to any live account. Helper children (`--type=`) are never orphans. Healthy state = empty.
- `reap-orphans` — terminates orphans; **dry-run by default**, requires `confirm: true`; never touches connectable/mapped instances, the launcher, or helpers of a live parent.

### Collection Workflow (primary targeting)

```
[build search URL] → collect-people(campaignId, sourceUrl) → campaign-status → campaign-start
```

- `collect-people` accepts a LinkedIn page URL + campaign ID; source type auto-detected from the URL; runs asynchronously.
- Optional params: `limit`, `maxPages`, `pageSize`, `sourceType`, `accountId` (required with multiple accounts).
- Poll `campaign-status`; start with `campaign-start` once enough people are collected.
- Only one collection runs at a time per instance (`CollectionBusyError` otherwise).

### Campaign Creation & Execution

```
describe-actions → campaign-create → [populate targets] → campaign-start → campaign-status / campaign-statistics
```

- Use `describe-actions` for authoritative action config schemas before building.
- `campaign-create` accepts YAML (default) or JSON.
- Populate targets via `collect-people` (recommended), `import-people-from-collection`, or `import-people-from-urls` (use the CLI `--urls-file` for 1000+ URLs).
- `campaign-start` requires `campaignId` + `personIds`; returns immediately (async).
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

`query-profile` (by `personId` or `publicId`), `query-profiles` (by name/headline/company with pagination). `campaign-list` connects via CDP and requires a running instance; pass `accountId` with multiple accounts.

---

## Parameter Conventions

- **`accountId`** — required for campaign/targeting/import/lifecycle tools when multiple accounts are configured; auto-resolved only with a single account.
- **`cdpPort`** — optional; auto-discovered (validated via `/json/version`) from running LH processes. Ports are **dynamic** — never hardcode. Pass explicitly only as a deterministic override/escape hatch (see CDP model). `9222` is valid only when LH was started by the auto-start script.
- **`cdpHost` / `allowRemote`** — default loopback (`127.0.0.1`). `allowRemote` enables non-loopback CDP (remote code execution risk) — only on a secured network path.
- **`campaignId` / `actionId` / `personId`** — internal LH integer IDs (not LinkedIn public IDs).
- **`publicId`** — LinkedIn URL slug (e.g. `jane-doe-12345`).
- **`format`** — campaign config `"yaml"` (default) or `"json"`.

---

## Resource & Time Efficiency

For a single-function automation box running several accounts:

- **Each running instance costs ~300–500 MB+** plus ~12 helper child processes. The launcher alone is ~350 MB. Start instances on demand; `stop-instance` when a job is done rather than leaving all accounts up.
- **Reads are cheap and launcher-independent.** Prefer `check-status`/`query-*` for status; don't spin up an instance just to read state you already have.
- **Don't over-poll.** `get-operation` every few seconds is enough; instance starts legitimately take ~35–90s.
- **Boot plan:** launcher auto-starts (~4s to CDP); then `ensure-instances([...])` only the accounts you need for the current run.
- **Antivirus:** exclude the LinkedHelper data dirs (`…\AppData\Local\linked-helper`, `…\AppData\Roaming\linked-helper`) to cut scan overhead and timing jitter — but keep AV running.

---

## Startup & Launcher Timing on Windows

- After `launch-app`, LH briefly drops its CDP port while reconnecting; auto-discovery retries up to ~30s. Expected.
- Lifecycle ops are serialized with settle barriers; a launcher CDP drop during them auto-recovers within ~30s.
- `check-status` intentionally bypasses retry for a fast health probe and remains correct even when the launcher is unreachable.
- Launcher CDP readiness ~4s post-launch; instance readiness ~35–90s.

---

## Error Patterns

| Error / symptom | Cause | Fix |
|---|---|---|
| "LinkedHelper is not running." | No LH process | `launch-app` |
| "LinkedHelper is running but CDP is not reachable" | Launcher CDP genuinely down (started without the flag), **or** — if `/json/version` actually answers — a discovery regression | Verify with Diagnostic Recipes; if `/json/version` answers, pass explicit `cdpPort` and flag a regression; else `launch-app --force` |
| "Instance not running" | Instance not started for account | `start-instance` (or `ensure-instances`) |
| "No accounts found" / "Multiple accounts" | Account resolution failed | `list-accounts`, then pass explicit `accountId` |
| "Campaign not found" | Invalid campaign ID | `campaign-list` for valid IDs |
| "Cannot collect — instance is busy" | Another collection in progress | Wait, then retry |
| Instance started but **not connectable** | Transient — launcher churn or still initializing | Re-poll `check-status` for ~30s; usually self-recovers |
| Instance non-connectable **past grace window** | Genuinely stuck | `restart-instance <accountId>` |
| `start-instance` result says `verified` with a real port matching `check-status` | Normal success (post-fix) | None |
| `start-instance` says `NOT verified — duplicate port suspected` | Verification ran during a port wobble — **or** a discovery regression | Confirm with `check-status`; if the instance is connectable, it's up. Persisting = regression |
| Launcher `reachable: false` while `processes[]` shows it connectable | Discovery regression (summary vs detail mismatch) | Use explicit `cdpPort`; flag for source fix |
| Account requested but **no instance process** appears | Account has no LH license / failed to launch | Reported as `failed`/`verified: false`; verify the license — not a tooling error |

---

## Diagnostic Recipes

When a reachability result looks wrong, confirm against the OS directly (PowerShell).

**What ports is each LH process actually listening on?**

```powershell
Get-CimInstance Win32_Process -Filter "Name='linked-helper.exe'" | ForEach-Object {
  $rdp = if ($_.CommandLine -match '--remote-debugging-port=(\d+)') { $matches[1] } else { 'none' }
  $listen = (Get-NetTCPConnection -OwningProcess $_.ProcessId -State Listen -ErrorAction SilentlyContinue |
             Select-Object -ExpandProperty LocalPort | Sort-Object -Unique) -join ','
  if ($listen) { "PID $($_.ProcessId) rdp-flag=$rdp listening=[$listen]" }
}
```

A launcher line like `listening=[9222, 51664]` is normal (CDP + secondary socket). The CDP port is the one with `--remote-debugging-port`.

**Does a candidate port actually speak CDP?**

```powershell
curl.exe --silent --fail http://127.0.0.1:9222/json/version
```

A JSON payload (with `webSocketDebuggerUrl`) = real CDP endpoint. No response = not CDP.

**Did the launcher come up cleanly at boot?**

```powershell
Get-Content (Join-Path $env:TEMP 'lh-cdp-startup.log') -Tail 20
```

---

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

Discover other IDs via the LinkedIn URL bar after applying a filter, the company-page "See all jobs" `f_C=` trick, or the typeahead XHR in DevTools. LinkedIn caps search results at ~2,500 per query — split large targets. Sales Navigator uses the nested `query=(filters:List(...))` syntax (percent-encoded).

## Rate Limiting

- Campaign actions: 100–200 visits/day safe; start at 50/day and scale; cooldown ≥60s; set `cooldownMs` (60000–90000) and `maxActionsPerRun` (5–10).
- Collection: cap with `limit` (~1000/run) and `maxPages`; one collection per instance.
- LinkedIn warnings are far easier to prevent than to undo — start conservative.

## Common Pitfalls

| Pitfall | Correct approach |
|---|---|
| Treating "CDP not reachable" as a real outage without checking | First probe `/json/version`; if it answers, it's a discovery issue — use explicit `cdpPort` and flag a regression |
| Identifying a CDP port by "the PID has a listening socket" | A CDP port is the one that answers `/json/version`; processes bind a second non-CDP socket |
| Expecting a long launcher warm-up after boot | Launcher CDP is up ~4s; post-boot failures point to discovery, not warm-up |
| Shortening the instance start wait | Instance readiness genuinely takes ~35–90s; let it warm up |
| Reading the running set from `databases[]` / the roster | Use `runningInstances[]` from `check-status` |
| Judging instance health on a single `connectable` read | Connectability is eventually-consistent; re-poll across the grace window |
| Raw back-to-back `start-instance` calls | Use `ensure-instances`/`restart-instance` — they serialize and settle |
| Trusting the `start-instance` payload port | Confirm real ports via `check-status` after settle |
| `launch-app force:true` then assuming port 9222 | Force picks a **new** dynamic port; pin with `launch-app cdpPort: 9222` if you need 9222 |
| Treating `--lh-account` as the instance's account | It's the license owner; use `--app-id`/`--user-li-id` |
| Counting `--type=` helper processes as instances/orphans | Helpers are children of a live parent — never instances/orphans |
| Hardcoding CDP ports | Re-derive each session — ports are dynamic |
| Leaving every account instance running | Each is ~300–500 MB; stop idle instances to free resources |
| Expecting instances to auto-start after reboot | Only the launcher auto-starts; start instances on demand |
