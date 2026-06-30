---
name: lhremote-mcp
description: This skill should be used when the user asks about lhremote MCP tools, LinkedHelper automation workflows, campaign management, account selection, instance lifecycle, instance health/connectability, CDP port discovery, people collection, messaging, or any lhremote CLI/MCP commands. Provides tool discovery, instance/account visibility, the CDP connection/port model, lifecycle and stability patterns, Windows auto-start behavior, workflow sequences, parameter conventions, error handling, diagnostics, and resource/rate guidance for automating LinkedHelper via CDP.
version: 0.25.0
updated: 2026-06-29
---

# lhremote MCP — Tool Surface & Workflow Guide

This skill teaches lhremote MCP workflow patterns, conventions, and error handling for automating LinkedHelper (LH) via Chrome DevTools Protocol (CDP).

It reflects the Insoftex **dev fork** of lhremote, including the **CDP port-validation fix** (validated 2026-06-24) that resolved intermittent false "CDP not reachable" failures on launcher operations. The **2026-06-26** update adds an error-code reference, the `query-profiles` scoping footgun, the `isDraft`/commit reality, and ephemeral single-action status. The **2026-06-29** update adds the mandatory Insoftex account-prefix convention for campaign names.

## Prerequisites

LinkedHelper must be installed locally with an active license per LinkedIn account. The MCP server connects via CDP. LinkedHelper runs as a **launcher** process plus, per started account, one **account-instance** process and a cluster of **Chromium helper child processes**.

---

## CDP Connection Model & Port Discovery

Read this before trusting or doubting any reachability result.

### Each LH process binds TWO listening sockets

A running launcher (and each running instance) opens **two** listening TCP sockets:

- the **real CDP/DevTools endpoint** — answers `http://127.0.0.1:<port>/json/version`;
- a **secondary ephemeral socket** the same Chromium/Electron process opens, which does **not** speak CDP.

```
launcher  PID 12548  --remote-debugging-port=9222  listening=[9222, 51664]
instance  PID 9852   (--remote-debugging-port=0)    listening=[52805, 64038]
```

`9222`/`52805` are CDP; `51664`/`64038` are non-CDP secondary sockets.

### The correct way to identify a CDP port

A CDP port is confirmed **only** by a successful `/json/version` probe — never by "this PID has a listening socket." The historical discovery bug latched onto the secondary socket (e.g. `51664`) and falsely reported the launcher unreachable while `9222` was serving. The current fork validates candidate ports via `/json/version` and pins the validated port.

### Regression signals

- A launcher op fails with "CDP is not reachable" while `/json/version` on the expected port answers fine.
- `check-status` summary says `reachable: false` while its `processes[]` entry shows `connectable: true`.
- The same launcher PID is reported on different ports across consecutive calls.

### Explicit-port escape hatch

Every lifecycle/launcher tool accepts an explicit `cdpPort`, bypassing auto-discovery:

```
start-instance(accountId, cdpPort: 9222)
stop-instance(accountId, cdpPort: 9222)
launch-app(cdpPort: 9222, force: true)
```

`9222` is correct only when LH was started by the auto-start script (or `launch-app cdpPort: 9222`); a plain `launch-app force:true` picks a **new** dynamic port.

> **Operational note (2026-06-26):** the explicit-port escape hatch remains valuable. Several reads this session were most reliable when the **instance** `cdpPort` was passed explicitly (e.g. campaign reads on a specific account). Reads are launcher-independent; passing the instance port avoids any launcher-side flakiness.

---

## Windows Auto-Start & Boot Behavior

- The **launcher auto-starts** at Windows sign-in via a Startup-folder shortcut chain.
- **Account instances do NOT auto-start.** Start them on demand with `start-instance` / `ensure-instances`.

Auto-start chain:

```
Startup shortcut
  → C:\Users\xuser\scripts\launch-linkedhelper-silent.vbs
    → C:\Users\xuser\scripts\launch-linkedhelper-silent.cmd
```

The silent `.cmd` launches `linked-helper.exe --remote-debugging-port=9222`, polls `http://127.0.0.1:9222/json/version`, force-relaunches a stale non-debug instance, and logs to `%TEMP%\lh-cdp-startup.log`.

Timing (measured): **launcher CDP up ~4s**; **instance startup ~35–90s**. Do not shorten the instance wait.

---

## Instance & Account Visibility

### Process model

- **Launcher** — single shared process; owns the launcher CDP port (dynamic). Binds CDP + a secondary socket.
- **Account-instance main process** — command line carries `--app-id`/`--user-li-id`/`--user-li`; no `--type=`; own dynamic CDP port. This is what you start/stop/restart.
- **Helper children** — `--type=` subprocesses; never instances/orphans; collapsed into `helperChildCount` (~12 per instance).

### Identity resolution

Parsed from the instance main process command line (`source: "cmdline"`, `confidence: "high"`), even when launcher CDP is down. `--lh-account` is the **license owner** (identical across instances) — never use it for per-instance identity.

### `check-status` — authoritative running state

Returns `launcher: { reachable, port }`, `runningInstances[]` (process-inspected), `databases[]` (full roster), `warnings[]`. Read the running set from `runningInstances[]`, not `databases[]`.

### `find-app` — process/role view

Launcher + classified instances, connectable-first. Use `find-app` for PID/port detail; `check-status` for the account-level running set.

> **Resource note:** the reference box runs 7 configured accounts. At **6 instances running concurrently** (~9 GB on a 16 GB box) the host approaches saturation and BOTH lhremote and Windows-MCP can hang together — a host-resource symptom, not an lhremote bug. Prefer **2–3 concurrent instances**; `stop-instance` when idle.

---

## Workflow Patterns

### Discovery Flow
```
find-app → check-status → list-accounts
```
If nothing is running, `launch-app` first.

### Instance Lifecycle
```
launch-app → start-instance → [work] → stop-instance → quit-app
restart-instance(accountId)          # recycle one stuck instance
ensure-instances(accountIds[])       # serialized starts + settle for a set
```
Lifecycle ops are launcher operations (need launcher CDP); they return `{ status:'in_progress', operationId }` when >2s — poll `get-operation`. Start ~35–90s, launch ~5–10s, stop ~10–60s. Confirm true state with `check-status`, not the immediate return payload.

### Connectability & Stability
Connectability is eventually-consistent — a fresh instance can read `connectable: false` for ~30s then self-recover. Re-poll before concluding failure (`readiness`: `connectable`/`starting`/`degraded`/`stuck`). `stuck` past grace → `restart-instance`. Never rapid-fire `start-instance`; use `ensure-instances`/`restart-instance`.

### Orphan Management
`list-orphans` (true orphans only; helpers never count). `reap-orphans` — dry-run by default, requires `confirm: true`.

### Collection Workflow
```
[build search URL] → collect-people(campaignId, sourceUrl) → campaign-status → campaign-start
```
One collection per instance (`CollectionBusyError` otherwise).

### Campaign Creation & Execution
```
describe-actions → campaign-create → [populate targets] → campaign-start → campaign-status / campaign-statistics
```
`campaign-create` accepts YAML (default) or JSON. Populate via `collect-people`, `import-people-from-collection`, or `import-people-from-urls` (CLI `--urls-file` for 1000+). `campaign-start` needs `campaignId` + `personIds`.

> For campaign **design/validation** (action ordering, reply detection, webhook placement, CRM rules, action `actionSettings` shapes), use the **linkedhelper-webhooks** skill and `lhremote-action-config-samples.md` — not this file.

### Insoftex Campaign Name Prefix

Before `campaign-create`, resolve the owning `accountId` and require the campaign name to use this format:

```text
<ACCOUNT_ABBREVIATION>: <descriptive campaign name>
```

Canonical example: `CEO: Lead Automation follow-up`

| LinkedHelper account | Required prefix |
|---|---|
| Michael Fliorko | `CEO:` |
| Mike Florko | `CTO:` |
| Michael Babylon | `MB:` |
| Liza Feder | `LF:` |
| Vira Lyn | `VL:` |
| Oleksandra Fliorko | `OF:` |

The prefix must match the account where the campaign is created. Missing, unrecognized, or mismatched prefixes are validation failures. Do not invent a prefix for an unlisted account.

### Campaign Action Chain Management
`campaign-add-action`, `campaign-remove-action`, `campaign-reorder-actions`, `campaign-move-next`, `campaign-update-action`.

> **`isDraft` / commit reality (2026-06-26):** `campaign-add-action` inserts new actions with `isDraft = 0` (lhremote does **not** create drafts). `campaign-update-action` does a shallow merge on `actionSettings` and **preserves** the existing `isDraft` flag — it will **not** clear `isDraft = 1`. Clearing a draft action requires a save in the LH UI. Whether LinkedHelper's runner skips `isDraft = 1` actions is **unverified**; to settle it, query LinkedHelper's SQLite (read-only) and check whether the action_ids appear in the latest committed `campaign_version` via `campaign_version_actions`. Never assert a draft node is skipped without that probe.

### Lists Management
```
create-collection → add-people-to-collection → import-people-from-collection → [reuse across campaigns]
```

### Messaging Workflow
```
check-replies → query-messages
```

### Data Queries (instance required, no campaign)
`query-profile` (by `personId`/`publicId`), `query-profiles` (by name/headline/company), `campaign-list-people`, `campaign-list`.

> **`query-profiles` scoping footgun (2026-06-26):** `query-profiles` is **GLOBAL** across all configured account DBs (no `accountId` scoping; reference box totaled ~195k profiles across 7 accounts). The `personId`s it returns are **not** valid in account-scoped tools and will fail there. For clean, account-scoped `personId`s (e.g. to feed `campaign-*` tools), use **`campaign-list-people`** instead.

---

## Parameter Conventions

- **`accountId`** — required for campaign/targeting/import/lifecycle tools when multiple accounts exist.
- **`cdpPort`** — optional; auto-discovered (validated via `/json/version`). Dynamic — never hardcode. Pass the **instance** port explicitly as a deterministic override for account-scoped reads/edits.
- **`campaignId` / `actionId` / `personId`** — internal LH integer IDs (not LinkedIn public IDs).
- **`publicId`** — LinkedIn URL slug.
- **`coolDown`** — top-level action field, ms = LH UI **"bunch time" / "Bunch Settings"**. **`maxActionResultsPerIteration`** = bunch size (`-1` unlimited). **`moveToSuccessfulAfterMs`** (in `actionSettings`) = "message analyzer period". **`Waiter.delay`** is in **hours**.
- **`format`** — campaign config `"yaml"` (default) or `"json"`.

---

## Resource & Time Efficiency

- Each running instance ~300–500 MB + ~12 helper children; launcher ~350 MB. Start on demand; stop idle instances.
- Reads are cheap and launcher-independent — prefer `check-status`/`query-*` for status.
- Don't over-poll `get-operation` (every few seconds). Instance starts legitimately take ~35–90s.
- Boot plan: launcher auto-starts (~4s); then `ensure-instances([...])` only the accounts you need. Keep concurrency to 2–3.
- Antivirus: exclude LH data dirs (`…\AppData\Local\linked-helper`, `…\AppData\Roaming\linked-helper`).

---

## Error Patterns

| Error / symptom | Cause | Fix |
|---|---|---|
| "LinkedHelper is not running." | No LH process | `launch-app` |
| "running but CDP is not reachable" | Launcher CDP down, **or** discovery regression if `/json/version` answers | Probe `/json/version`; if it answers, pass explicit `cdpPort` + flag regression; else `launch-app --force` |
| "Instance not running" | Instance not started | `start-instance` / `ensure-instances` |
| "No accounts found" / "Multiple accounts" | Resolution failed | `list-accounts`, pass explicit `accountId` |
| "Campaign not found" | Invalid ID | `campaign-list` |
| "Cannot collect — instance is busy" | Collection in progress | wait, retry |
| Instance started but not connectable | Transient | re-poll ~30s |
| Non-connectable past grace | Stuck | `restart-instance` |
| Account requested but no instance process | No LH license / failed launch | reported `failed`/`verified:false` — verify license |
| `"workspaceId" must be a number` (launcher UI) | **LinkedHelper's own launcher↔cloud workspace sync** — not lhremote | re-login / re-select workspace in LH; check for LH update. Not caused by lhremote campaign/instance ops; does not block CDP reads while instances stay connectable |
| Single Action "X" failed: "incorrect action type" | Ephemeral single-action path (see below) | `dismiss-errors`; use fixed build — re-test required |

---

## Ephemeral single-action tools (status 2026-06-26)

`visit-profile`, `follow-person`, `unfollow-profile`, `like-person-posts`, `endorse-skills`, `message-person`, `send-invite`, `send-inmail`, `remove-connection`, `comment-on-post`, `react-to-post`, `react-to-comment` run as "ephemeral campaigns" / single actions.

- A bug caused these to fail with LH "incorrect action type: VisitAndExtract" and leave a **blocking instance popup**; a full LH crash followed in one case. `get-errors` detects the popup; `dismiss-errors` (with explicit instance `cdpPort`) clears it.
- A fix was applied via Claude Code this session. **Re-test required** before relying on the family: confirm `visit-profile(accountId, personId)` succeeds with no leftover popup, confirm one reversible sibling (e.g. `follow-person` → `unfollow-profile`), and confirm a clean failure path leaves no blocking popup and no crash. Until re-tested, treat as **unverified**.
- For benign validation prefer `visit-profile` (a profile view); do **not** fire outreach-type ephemeral actions (invite/message/like/comment) at cold/non-consenting people during testing.

---

## Error-Code Reference (from live `campaign-statistics`, 2026-06-26)

`topErrors[]` carries `{ code, count, isException, whoToBlame }`. Working key (interpretation inferred from `whoToBlame` + context — not an official LH codebook):

| Code | Blame | Action(s) | Working interpretation |
|---|---|---|---|
| 271403 | LinkedIn | InvitePerson | Invite can't complete for this profile (out-of-network / restricted / changed). Per-contact, retryable |
| 270013 | LinkedIn | InvitePerson | Most common LinkedIn invite rejection (limit / cannot-invite class) |
| 270008 / 270009 | LinkedIn | InvitePerson | LinkedIn invite-rejection variants |
| 270020 / 340001 | LH | InvitePerson | LH-side exception during invite (low rate) |
| 380001 | LH | MessageToPerson | **Recurring** LH-side message exception (135 ×70, 141 ×4) — escalate to dev |
| 60016 / 60031 / 60403 / 30003 | LinkedIn | MessageToPerson | LinkedIn message rejections (cannot message / restricted thread) |
| 870030 | LH | SendPersonToWebhook | Webhook-delivery exception (record not pushed to EspoCRM/n8n) |
| 1140006 | LH | PersonPostsLiker | LH-side engagement exception |
| 1140010 | Proxy | PersonPostsLiker | Proxy-side failure |

Interpretation rules: a `FilterContactsOutOfMyNetwork` **`failed`** count = profiles **not yet accepted** (held in Queue), **not** errors — report acceptance rate instead. `whoToBlame: LinkedIn` = per-contact / external (often retryable via `campaign-retry`); `whoToBlame: LH` with `isException: true` = tooling/runtime issue worth escalating; `whoToBlame: Proxy` = network/proxy.

---

## Diagnostic Recipes (PowerShell)

**Ports each LH process listens on:**
```powershell
Get-CimInstance Win32_Process -Filter "Name='linked-helper.exe'" | ForEach-Object {
  $rdp = if ($_.CommandLine -match '--remote-debugging-port=(\d+)') { $matches[1] } else { 'none' }
  $listen = (Get-NetTCPConnection -OwningProcess $_.ProcessId -State Listen -ErrorAction SilentlyContinue |
             Select-Object -ExpandProperty LocalPort | Sort-Object -Unique) -join ','
  if ($listen) { "PID $($_.ProcessId) rdp-flag=$rdp listening=[$listen]" }
}
```

**Does a candidate port speak CDP?**
```powershell
curl.exe --silent --fail http://127.0.0.1:9222/json/version
```

**Find a specific account's instance port:**
```powershell
Get-CimInstance Win32_Process -Filter "Name='linked-helper.exe'" |
  ? { $_.CommandLine -match '--app-id=570886' -and $_.CommandLine -notmatch '--type=' }
```

**Boot log:**
```powershell
Get-Content (Join-Path $env:TEMP 'lh-cdp-startup.log') -Tail 20
```

---

## Action Type Reference

Use `describe-actions` for full schemas. Types: `VisitAndExtract`, `InvitePerson`, `MessageToPerson`, `InMail`, `CheckForReplies`, `Follow`, `EndorseSkills`, `PersonPostsLiker`, `FilterContactsOutOfMyNetwork`, `RemoveFromFirstConnection`, `DataEnrichment`, `ScrapeMessagingHistory`, `Waiter`. Note `SendPersonToWebhook` executes at runtime but is not in the modeled catalog (linter "unknown type" is expected). For verified `actionSettings` shapes, see `lhremote-action-config-samples.md`.

## Source Type Reference (`collect-people` auto-detects from URL)

**Free:** `SearchPage`, `MyConnections`, `Alumni`, `OrganizationPeople`, `Group`, `Event`, `LWVYPP`, `SentInvitationPage`, `FollowersPage`, `FollowingPage`.
**Sales Navigator:** `SNSearchPage`, `SNListPage`, `SNOrgsPage`, `SNOrgsListsPage`.
**Recruiter:** `TSearchPage`, `TProjectPage`, `RSearchPage`, `RProjectPage`.

## Building LinkedIn Search URLs

Base `https://www.linkedin.com/search/results/people/?` with `&key=value`. Faceted filters use URL-encoded JSON arrays. Key params: `keywords`, `network` (`F`/`S`/`O`), `geoUrn`, `currentCompany`, `pastCompany`, `school`, `industry`, `profileLanguage`, `title`, `connectionOf`. Geo URNs: US 103644278, Canada 101174742, UK 101165590, France 105015875, Germany 101282230, India 102713980, Australia 101452733, SF Bay Area 90000084. LinkedIn caps search at ~2,500/query — split large targets.

## Rate Limiting

- Campaign actions: 100–200 visits/day safe; start at 50/day; cooldown ≥60s (`coolDown` 60000–90000); `maxActionResultsPerIteration` 5–10.
- Collection: `limit` (~1000/run), `maxPages`; one collection per instance.
- LinkedIn warnings are easier to prevent than undo — start conservative.

## Common Pitfalls

| Pitfall | Correct approach |
|---|---|
| Treating "CDP not reachable" as an outage without checking | Probe `/json/version`; if it answers, use explicit `cdpPort` + flag regression |
| Identifying a CDP port by "PID has a listening socket" | Confirm via `/json/version`; processes bind a second non-CDP socket |
| Reading running set from `databases[]` | Use `runningInstances[]` |
| Judging health on a single `connectable` read | Re-poll across the grace window |
| Raw back-to-back `start-instance` | Use `ensure-instances` / `restart-instance` |
| Hardcoding CDP ports | Re-derive each session |
| Leaving every instance running | Stop idle instances; keep 2–3 concurrent |
| Expecting instances to auto-start after reboot | Only the launcher auto-starts |
| Using `query-profiles` IDs in account-scoped tools | It's global; use `campaign-list-people` for scoped IDs |
| Expecting `campaign-update-action` to clear `isDraft` | It preserves the flag; clearing needs the LH UI |
| Asserting a draft node is skipped | Unverified — run the `campaign_version` membership probe |
| Blaming lhremote for the `workspaceId` launcher error | It's LH's own workspace sync; re-login/re-select workspace in LH |
| Reading a Filter's `failed` count as errors | It's not-yet-accepted profiles; report acceptance rate |
| Creating a campaign with no prefix or the wrong account prefix | Use `<ABBREVIATION>: <descriptive name>` and match the owning account |
