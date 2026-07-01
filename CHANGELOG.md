# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [0.24.0] — 2026-07-01

### Added

- **Campaign target verification by LinkedIn URL** — `campaign-list-people` now supports
  `--urls` and `--urls-file` on the CLI, with matching MCP support underneath.  The operation
  parses LinkedIn profile URLs into public IDs, filters campaign people against those IDs,
  returns matched entries plus unresolved URLs, and is covered by unit and end-to-end tests.
  ADR-010 documents the decision and tradeoffs.

- **Regression coverage for launcher and campaign edits** — Added a multi-instance detection
  regression test for the "launcher CDP down" case and an end-to-end test that verifies campaign
  action reordering still behaves correctly after edits.

- **Broader visit-profile end-to-end coverage** — Added tests for URL-based profile visits and
  for failure handling when a bad `personId` is supplied, including verification that the
  instance remains connectable after the failed action.

### Fixed

- **Launcher CDP port discovery is more reliable when the launcher is degraded** — Instance and
  app discovery now better distinguish real instance endpoints from launcher or non-instance CDP
  targets when multiple processes are present or the launcher CDP is unavailable.  Status and
  discovery flows now classify running instances more accurately in that failure mode.

- **`visit-profile` no longer reports false success on failed ephemeral execution** — When the
  ephemeral campaign service returns `success: false`, the operation now throws a
  `CampaignExecutionError` instead of returning stale profile data as though the action succeeded.

- **Ephemeral cleanup clears leftover LinkedHelper dialogs** — After `safeStop()`,
  `EphemeralCampaignService.cleanup()` now performs a best-effort popup-dismiss sweep so action
  failure dialogs do not poison the next ephemeral run.

- **`visit-profile` API surface now matches sibling ephemeral action tools** — `keepCampaign`
  and `timeout` are now accepted and forwarded consistently through core and MCP layers, with
  tests covering the passthrough behavior.

### Changed

- **Version surface advanced to `0.24.0`** — The workspace package manifests, package-specific
  manifests, plugin/server metadata, and staging dist manifest now advertise the same feature
  release version.

## [0.23.2] — 2026-06-23

### Fixed

- **Launcher-CDP contention eliminated** — All launcher CDP sessions now pass through a single
  in-process async gate (`withLauncherCDPGate`) so that at most one session is open at any
  moment.  `list-accounts`, `start-instance`, `stop-instance`, `ensure-instances`, and the
  stop/start phases of `restart-instance` each acquire the gate before connecting and release it
  immediately after disconnecting.  Concurrent in-process tools no longer collide at the CDP level.

- **Restart hold window shrunk from minutes to seconds (F2)** — `restart-instance` previously
  held the launcher CDP connection for the entire operation (~2 m 15 s), blocking all other
  launcher-dependent tools.  The connection is now opened only for the individual stop RPC and
  start RPC, and released immediately after each.  The PID-exit wait and connectable-poll run
  with no launcher connection held.  A clean uncontended restart now completes in well under 15 s.

- **Contention-resilient acquisition (F3)** — `LauncherService.reconnect()` previously passed
  the full remaining budget as the per-iteration `resolveAppPort` timeout, allowing one stalled
  port scan to consume the entire 60 s budget.  Each iteration now caps the resolve timeout at
  5 s so the retry loop remains responsive across up to 12 attempts within the budget.  Under
  external-client contention (e.g. a concurrent CLI session), `restart-instance` backs off and
  retries rather than hard-failing.

- **Reconnect loop now retries when launcher port is temporarily absent** — When the launcher
  briefly drops its CDP port after processing a write op (stop/start), `resolveAppPort` inside
  `LauncherService.reconnect()` threw `LinkedHelperUnreachableError`, which propagated
  immediately out of the retry loop — burning only one 5 s scan instead of the full 60 s budget.
  The loop now catches `LinkedHelperUnreachableError` from `resolveAppPort`, pauses 500 ms,
  and retries within the remaining budget.  `LinkedHelperNotRunningError` (launcher process gone)
  still propagates immediately.  Only the F3 cap-related fix was shipped in 0.23.2 initially;
  this completes the intent of that fix.

- **Integration test suites skip gracefully when Playwright Chromium is absent** — The four
  CDP/DOM integration test suites previously threw at the suite level when the Chromium binary was
  not installed, causing `pnpm test` to exit non-zero.  They now use `describe.skipIf` so the
  suite is skipped rather than failed.  CI still installs Chromium via `playwright install`, so
  integration coverage is unaffected there.

- **Granular restart progress (F4)** — `restart-instance` now emits a progress message at every
  sub-step: `scanning-instances` → `acquiring-launcher (stop)` → `stopping <accountId>` →
  `waiting-for-exit` → `acquiring-launcher (start)` → `starting` → `waiting-for-connectable`
  → `verifying` → `verified` (or `verified=false`).  A ~2 min gap between progress messages
  is no longer possible.

## [0.23.1] — 2026-06-23

### Fixed

- **Long-running server could not acquire launcher CDP after prior ops** — `CDPClient` had a
  fire-and-forget auto-reconnect that ran after any unexpected WebSocket close.  When
  `LauncherService.reconnect()` replaced the old `CDPClient` with a fresh one, the orphaned old
  client's background reconnect would eventually succeed (after the new connection was properly
  disconnected in the operation's `finally` block), grabbing the launcher's CDP target
  indefinitely.  All subsequent `acquireLauncherWithRecovery` calls saw
  `webSocketDebuggerUrl: null` ("another debugger may be attached") and busy-looped in
  `reconnect()` for the full 60-second budget before failing with "LinkedHelper is running but
  CDP is not reachable."  Fresh CLI processes worked because they had no orphaned
  `CDPClient`s.  Fix: removed `CDPClient` auto-reconnect entirely — `LauncherService` and
  `withLauncherRecovery` manage all reconnection explicitly.  Also added a 500 ms pause
  between `reconnect()` loop iterations to prevent busy-looping when the target is
  momentarily taken.

## [0.23.0] — 2026-06-23

### Added

- **Async operation model (T2)**: Long-running tools (`restart-instance`, `ensure-instances`,
  `start-instance`, `stop-instance`, `launch-app`, `quit-app`) now use a 2-second grace window.
  If the operation completes within 2 s it returns synchronously; otherwise it returns
  `{ status: "in_progress", operationId }` immediately and continues in the background.
  Three new MCP tools manage async operations:
  - `get-operation` — poll a running or completed operation by ID
  - `cancel-operation` — request cancellation; ongoing work is aborted via `AbortSignal`
  - `list-operations` — enumerate active and recently completed operations (10-min TTL)

- **MCP progress & cancellation (T4)**: All async operation work functions receive a merged
  `AbortSignal` that is triggered by either operation cancellation or the MCP
  `notifications/cancelled` message for the originating request.

- **Flap-tolerant launcher acquisition (T3)**: `acquireLauncherWithRecovery` now accepts and
  threads an `AbortSignal` through all recovery and wait functions.  `AbortSignal` also added
  to `resolveAppPort`, `waitForPidExit`, `waitForConnectable`, and `LauncherService.reconnect`.

### Changed

- **Non-blocking startup (T1)**: MCP `initialize` / `tools/list` perform zero I/O — all tool
  registrations are synchronous.  Launcher connections are established lazily on the first
  tool call, not at registration time.

- Single-writer semantics: tools that mutate launcher state check `getActiveWriteOp()` at
  entry and reject concurrent mutating calls with a clear error.

## [0.22.2] — 2026-06-22

### Fixed

- **`restart-instance` survives the launcher CDP drop it triggers (root cause fix)**: Three
  composable defects caused `restart-instance` (and siblings) to fail with the legacy
  `LinkedHelperUnreachableError` string even though the instance restarted successfully.
  All three are now closed:

  - **F1 — Launcher-independent restart verification**: `restartInstance` steps 4–6 now
    decouple "issue the start command" (needs launcher CDP briefly) from "verify the result"
    (must not need the launcher).  After the start command is issued, verification falls
    through to `waitForConnectable`, which uses `scanRunningInstances` / pure OS process
    inspection — no launcher CDP required.  The op can return `restarted:true, verified:true`
    while the launcher is still flapping.  Previously a `{status:"timeout"}` from
    `startInstanceWithRecovery` (caused by `discoverInstancePort` failing after the launcher
    port-hopped) produced an immediate early return with `verified:false`, even though the
    instance was running and connectable.  `RestartInstanceResult` gains an optional `note`
    field for the rare case where the launcher never recovered and process inspection is the
    sole information source.  The same process-inspection fallback is applied to
    `start-instance` (MCP tool) and `ensure-instances` (Phase 2).

  - **F2 — Resolve+connect+reconnect as one recoverable unit**: `acquireLauncherWithRecovery`
    previously called `resolveLauncherPort` (with its full 30 s retry budget) **outside** the
    `try { connect() } catch { reconnect() }` block, so a `LinkedHelperUnreachableError` thrown
    during port resolution bypassed recovery entirely.  The fast-path resolve call now uses
    `retryTimeout=0` (single scan, immediate fail) inside the function; any
    `LinkedHelperUnreachableError` from either resolve or connect is handled identically: fall
    to `reconnect()`, which re-discovers the launcher's current port fresh on each attempt
    (never pinned to a stale port like 49238) and retries with back-off up to the full budget.
    `LinkedHelperNotRunningError` still propagates immediately.

  - **F3 — Longer recovery budget**: `DEFAULT_LAUNCHER_RECOVERY_TIMEOUT_MS` raised from 30 s
    to **60 s** (also honoured by `LHREMOTE_LAUNCHER_RECOVERY_TIMEOUT_MS`), covering the
    observed worst-case port-hop window.  `reconnect()` passes this budget directly to
    `resolveAppPort` so the per-iteration discovery window matches the overall cap.

## [0.22.1] — 2026-06-22

### Fixed

- **Launcher write ops no longer fail instantly on a CDP blip (Bug 1)**: `restart-instance`,
  `start-instance`, `stop-instance`, `ensure-instances`, and `list-accounts` previously
  performed a single raw `connect()` call before entering the queue; if the launcher
  dropped CDP during that window the operation failed immediately with the legacy
  "Relaunch LinkedHelper with --remote-debugging-port" error instead of recovering.
  All five tools now call `acquireLauncherWithRecovery`, which re-discovers the
  launcher's current port via process inspection and retries the connection with the
  same 30 s cap as the existing operation-level `withLauncherRecovery`.  Callers use
  `launcher.currentPort` (new getter on `LauncherService`) to get the live port after
  potential recovery, so downstream ops (`discoverInstancePort`, settle barriers) always
  reference the right port.  The legacy error now only surfaces when recovery genuinely
  fails past the cap.

- **Non-ASCII / emoji names no longer mangled to `????` in `check-status` (Bug 2)**:
  `gather-raw-processes.ts` now prepends
  `[Console]::OutputEncoding = $OutputEncoding = [System.Text.Encoding]::UTF8;`
  to the PowerShell `Win32_Process` query.  Windows PowerShell 5.x defaults to OEM
  encoding; without this, multi-byte characters (e.g. the 🇺🇦 emoji in account names)
  were replaced with `?` before Node.js read them.  `list-accounts` (DB-sourced) was
  unaffected; this fix aligns `check-status` to show the same names.

## [0.22.0] — 2026-06-22

### Added

- **`restart-instance` MCP tool and CLI command (T3)**: Recycles a single stuck
  instance — stop → wait for PID exit → start → wait until connectable →
  verify `--app-id` match on a distinct port. Idempotent: no-op when already
  healthy unless `force:true`. Only the target account's process is touched;
  all other instances keep running. Returns
  `{ accountId, restarted, oldPid, newPid, cdpPort, verified, launcherRecovered }`.
- **Launcher operation queue (T1)**: All write/lifecycle operations
  (`start-instance`, `stop-instance`, `restart-instance`, `launch-app`,
  `quit-app`, and each internal start within `ensure-instances`) are serialised
  through a single in-process async mutex. After each op, a settle barrier waits
  for the launcher CDP to be reachable again and (for starts) the target instance
  to become connectable, before releasing the queue for the next operation. Converts
  "rapid starts → launcher drop → cascade" into "op → settle → op".
- **Instance readiness model (T2)**: `InstanceReadinessTracker` tracks per-PID
  state across successive scans; distinguishes `connectable | starting | degraded |
  stuck`. `waitForConnectable(accountId, opts)` polls until the account's instance
  is connectable on a real distinct port (or timeout), with optional cheap
  `isCdpPort` re-probe when a known port is supplied. `check-status` now includes
  a `readiness` field per instance.
- **Process inspection cache (T6)**: `gatherRawProcesses` results are cached for
  ~1 500 ms (configurable via `LHREMOTE_INSPECTION_CACHE_TTL_MS`) to avoid
  redundant Win32_Process WMI queries during poll loops. Cache is invalidated
  immediately after every lifecycle op via `invalidateProcessCache()`.
- **`waitForPidExit(pid, timeoutMs?)` (T5)**: Polls until a PID fully exits using
  signal-0 probing; used by `restart-instance` and the hardened `stop-instance`.
- **`docs/instance-stability.md`**: Explains the launcher-queue + readiness model,
  grace-window/transient-vs-stuck semantics, all config knobs with defaults and
  rationale, and the read-vs-write reliability boundary.

### Changed

- **`start-instance` (T5)**: Routes through the launcher queue; the settle barrier
  waits for the launcher to recover and the instance to become connectable before
  the next queued op can start. Verification uses `waitForConnectable` so a
  phantom/duplicate port is only declared `verified:false` after the full
  connectable timeout.
- **`stop-instance` (T5)**: Routes through the launcher queue; waits for the
  instance port to disappear via `waitForInstanceShutdown` before returning.
- **`ensure-instances` (T4)**: Each internal start is serialised through the
  launcher queue with a settle barrier between accounts (no more cascade).
  Verification uses parallel `waitForConnectable` in Phase 2 so accounts that
  take longer to settle are not mis-reported as `verified:false`. An unlicensed
  account with no process ever appearing is now reported as `status:"failed"` with
  a clear reason rather than a phantom success.
- **`check-status`**: `instances[]` entries now include `readiness:
  "connectable"|"starting"|"degraded"|"stuck"` alongside existing fields.

### Configuration (T7)

All new timings ship with sane defaults and are overridable via environment variables:

| Env var | Default | Meaning |
|---------|---------|---------|
| `LHREMOTE_GRACE_WINDOW_MS` | 30 000 | Grace window before a non-connectable instance is considered `stuck` |
| `LHREMOTE_CONNECTABLE_TIMEOUT_MS` | 45 000 | `waitForConnectable` overall timeout |
| `LHREMOTE_CONNECTABLE_INTERVAL_MS` | 1 500 | Poll interval inside `waitForConnectable` |
| `LHREMOTE_SETTLE_BARRIER_TIMEOUT_MS` | 30 000 | Queue settle barrier timeout |
| `LHREMOTE_INSPECTION_CACHE_TTL_MS` | 1 500 | Process inspection cache TTL |
| `LHREMOTE_LAUNCHER_RECOVERY_TIMEOUT_MS` | 30 000 | (existing) Launcher recovery cap |

## [0.21.0] — 2026-06-21

Baseline: upstream 0.20.1. This fork branches above upstream to eliminate the
`0.3.x < 0.20.1` semver confusion. All changes below are relative to upstream
0.20.1.

### Added

- **Launcher CDP auto-recovery (F3)**: before any launcher-dependent operation
  (`list-accounts`, `start-instance`, `stop-instance`, `list-workspaces`, …)
  the service detects an unreachable CDP endpoint and automatically re-discovers
  the launcher's current debugging port (dynamic; never assumed to be 9222) then
  reconnects with exponential backoff up to a configurable cap (default 30 s).
  Results include a `launcherRecovered: boolean` field so callers know a
  recovery took place.
- `LauncherService.reconnect(options?)` — explicit reconnect with port
  re-discovery and bounded backoff; cap configurable via `timeoutMs` option or
  `LHREMOTE_LAUNCHER_RECOVERY_TIMEOUT_MS` env var.
- `withLauncherRecovery(launcher, op, options?)` utility exported from core —
  runs an operation, catches launcher-CDP errors, calls `reconnect()` once, and
  retries; returns `{ result, launcherRecovered }`.
- Self-contained ESM bundle (`dist-bundle/lhremote-mcp.mjs`) and matching
  `.mcpb` package (`dist-mcpb/lhremote-0.21.0.mcpb`) for durable Claude
  Desktop extension deployment that does not depend on workspace symlinks.
- `docs/packaging.md` — how to rebuild the bundle and `.mcpb`, install steps,
  and the invariant that the shipped manifest must point at the bundled path.

### Fixed

- **Instance visibility (R1–R5)** (backport from 0.3.1): `check-status`
  `instances[]` now reflects OS-process-inspected running processes only
  (Win32_Process on Windows), not the full 7-account launcher roster.
  `instances[].cdpPort` / `connectable` carry live-probe values. Identity
  parsed from `--app-id`/`--user-li-id`/`--user-li` only; `--lh-account`
  (license-owner decoy) is ignored. Instances array remains correct when
  launcher CDP is unreachable.
- **Name-resolution** (backport from 0.3.1): `find-app` role classification
  uses `--type=` presence for helper-child detection and `resources\out\` path
  for instance main processes; `helperChildCount` added per entry.

### Security

- Command-line secrets (`--app-credentials`, `--upstream-proxy`, `--sentry` DSN,
  `socks5://` proxy URLs, encrypted passwords) are never captured, stored, or
  surfaced in any tool output, log, or auto-recovery path.

## [0.3.1] — 2026-06-21

### Fixed

- `check-status` `instances[]` now reflects only genuinely running processes from OS process inspection (Win32_Process on Windows), not all 7 configured accounts from the launcher roster (R1)
- `instances[].cdpPort` and `instances[].connectable` now carry real values from live process probing instead of always being `null` (R2)
- Instance identity (`accountId`, `name`, `email`) is parsed from `--app-id`/`--user-li-id`/`--user-li` only — `--lh-account` (license-owner decoy, identical across all instances) is now explicitly ignored (R3)
- `instances[]` remains correct when the launcher CDP is unreachable; `launcher.reachable` is a separate flag (R4)
- `find-app` role classification: `--type=` present → `helper-child` (excluded by default); `resources\out\` path → `instance`; otherwise `launcher`; added `helperChildCount` per entry (R5)

### Added

- `gather-raw-processes` shared utility — abstracts OS process listing with cmdlines (Win32_Process via PowerShell on Windows; ps-list `cmd` on other platforms)
- `FindAppOptions.includeHelpers` — opt-in to show helper-child processes in `find-app` output (CLI `--verbose` flag)
- `StatusReport.instances` — authoritative process-inspection-based array (same data as `runningInstances`, which is retained for backward compatibility)
- `docs/instance-visibility.md` — process taxonomy, cmdline identity fields, `--lh-account` trap, redaction requirements

### Security

- Command line secrets (`--app-credentials`, `--upstream-proxy`, `--sentry` DSN) are never captured, stored, or returned in any tool output or log

## [0.9.0] — 2026-04-01

### Added

- Humanization layer for all LinkedIn interactions — Gaussian delay distribution, page settling, humanized mouse movement via LH's VirtualMouse, click jitter, scroll randomization, post-action dwell, character-aware typing cadence with word/sentence boundary pauses, CDP fallback mouse path, session-level pacing with cool-down and micro-breaks, idle mouse drift, pre-focus hover, reading simulation, and humanized retries
- Smart port resolution with direct instance connection — auto-discovers instance CDP port without manual configuration
- Dialog dismissal on LauncherService (`dismissInstanceDialog`, `stopInstanceWithDialogDismissal`)
- `connectUiOnly()` on InstanceService for partial-start resilience
- `CDPClient` export from `@insoftex/lhremote-core`

### Changed

- Feed posts now use URL as primary identifier (URN dropped)
- Feed and post operations migrated from Voyager API interception to DOM scraping for LinkedIn SSR compatibility
- `FeedPost.url` is now nullable with automatic retry URL extraction
- Explicit `cdpPort` required for non-loopback host connections
- CLI no longer defaults `cdpPort` to `DEFAULT_CDP_PORT`

### Fixed

- Override `ELECTRON_RUN_AS_NODE` to restore CDP connectivity on LinkedHelper v2.113.9+
- Prevent health check infinite recursion and fix campaign runner start sequence
- Detect wrong CDP port and classify launcher vs instance processes
- Wire dialog-aware stop into `forceStopInstance` and crash recovery
- Use webpack account service cache for `listAccounts` performance
- Discover instance port before popup detection in `get-errors` and `dismiss-errors`
- Add `Array.isArray` guard in `discoverTargets`
- Remove dead VoyagerInterceptor code

## [0.8.0] — 2026-03-22

### Added

- `visit-profile` tool for visiting a LinkedIn profile as a standalone action
- `get-feed` tool for fetching the LinkedIn home feed
- `get-profile-activity` tool for viewing a profile's recent activity
- `search-posts` tool for searching LinkedIn posts
- `get-post` tool for retrieving single post details with comments
- `get-post-stats` tool for post engagement statistics
- `get-post-engagers` tool for listing users who engaged with a post
- `react-to-post` tool for reacting to LinkedIn posts
- `comment-on-post` tool for commenting on LinkedIn posts
- `like-person-posts` tool for liking a person's recent posts
- `message-person` tool for sending direct messages
- `send-invite` tool for sending connection invitations
- `send-inmail` tool for sending InMail messages
- `endorse-skills` tool for endorsing a person's LinkedIn skills
- `enrich-profile` tool for enriching stored profile data via VisitAndExtract
- `follow-person` tool for following LinkedIn profiles
- `remove-connection` tool for removing LinkedIn connections
- `get-action-budget` tool for querying daily action budget usage
- `get-throttle-status` tool for checking LinkedIn throttle status
- `campaign-erase` tool for permanent campaign deletion (bypasses soft delete)
- `dismiss-errors` tool for clearing instance UI error popups
- Instance UI popup detection via CDP with visibility filtering and cross-strategy deduplication
- Health checker integration for automatic instance popup detection
- Ephemeral campaign service for executing individual actions without persistent campaign setup
- DOM automation primitives for LinkedIn WebView interaction
- Voyager API interceptor for capturing LinkedIn API responses
- LinkedIn CSS selectors registry for robust element targeting

### Changed

- `campaign-delete` gained `hard` option for permanent deletion alongside the default soft delete
- `get-errors` enhanced to include instance UI popups
- `query-profile` gained URL-based lookup support

### Fixed

- Null school handling in profile data extraction
- Poll `canCollect` after navigation instead of single check
- Bound poll delay to remaining deadline time

## [0.7.0] — 2026-03-20

### Added

- `build-linkedin-url` tool for constructing LinkedIn URLs from entity types, reference data, and search parameters
- `resolve-linkedin-entity` tool for resolving LinkedIn entity identifiers to names and metadata
- `list-linkedin-reference-data` tool for listing LinkedIn reference data (industries, regions, company sizes, etc.)
- LinkedIn URL builder service with boolean expression support for complex search queries
- LinkedIn search URL builder for Sales Navigator advanced searches

### Fixed

- Navigate LinkedIn webview to source URL before collection
- Respect `force` flag in `launch-app` when a connectable app already exists
- Resolve Node.js execution context for launcher CDP injection

## [0.6.0] — 2026-03-17

### Added

- `list-collections` tool for listing LinkedHelper collections (Lists)
- `create-collection` and `delete-collection` tools for collection CRUD operations
- `add-people-to-collection` and `remove-people-from-collection` tools for managing collection membership
- `collect-people` tool for collecting people from LinkedIn pages into campaigns
- `import-people-from-collection` tool for importing collection members into a campaign
- `CollectionService` for LinkedHelper collection management via IPC
- Source type registry for LinkedIn page URL detection and classification

## [0.5.0] — 2026-03-17

### Added

- `LinkedHelperUnreachableError` to distinguish "LH not running" from "LH running but CDP unreachable"
- Proactive process conflict detection in `AppService.launch()` — prevents spawning duplicate LinkedHelper instances
- `force` option for `AppService.launch()` and `launch-app` MCP tool to kill stale processes before relaunching
- Process-level detection in `checkStatus()` when launcher is unreachable — reports discovered PIDs in `StatusReport`
- `LauncherService.connect()` now throws `LinkedHelperUnreachableError` (with PIDs) instead of the misleading `LinkedHelperNotRunningError` when LH processes are detected
- MCP error mapping for `LinkedHelperUnreachableError` with actionable restart guidance

## [0.4.0] — 2026-03-03

### Added

- `query-profiles-bulk` tool for batch profile lookups by multiple person IDs
- `campaign-remove-people` tool to remove targets from a campaign
- `campaign-update-action` tool for updating action settings
- `campaign-list-people` tool to enumerate campaign targets
- `includePositions` option for `query-profile` to include career history (positions)
- Profile data included in `campaign-status` results

### Fixed

- `scrape-messaging-history` now requires `personIds` parameter — previously crashed with empty config when no person IDs were provided
- Runtime validation for empty `personIds` at the core operation boundary

## [0.3.0] — 2026-03-02

### Added

- `includeHistory` option for `query-profiles` to search across past positions (company history), not just current employer
- Automatic chunking for `import-people-from-urls` — large URL sets are split into batches of 200 with aggregated results
- Rate limiting guidance section in Getting Started guide with recommended daily limits for VisitAndExtract campaigns
- Rate limiting note in `VisitAndExtract` action type description (surfaced by `describe-actions`)

### Changed

- Replaced SHA-pinned GitHub Actions with major version tags for readability and reduced Dependabot noise
- Added MCP Registry metadata for tool discoverability

## [0.2.2] — 2026-02-19

### Added

- Detection and surfacing of LinkedHelper UI errors, dialogs, and blocking popups
- Claude Code plugin packaging for IDE integration

### Fixed

- Missing `created_at` in `moveToNextAction` INSERT causing database errors
- Test fixture schema alignment with real LinkedHelper database

### Changed

- Removed unused `InstanceService.navigateToProfile` method
- Removed unused `InstanceService.triggerExtraction` method

## [0.2.1] — 2026-02-16

### Fixed

- Database opened read-only in `campaign-create` and `campaign-start` operations, causing "attempt to write a readonly database" errors
- Campaign config format documentation in MCP skill showing internal field names instead of portable document format

## [0.2.0] — 2026-02-16

### Added

- `campaign-create` tool for creating campaigns from YAML/JSON definitions with action chains
- `campaign-get`, `campaign-list`, `campaign-delete` tools for campaign CRUD operations
- `campaign-export` tool for exporting campaigns to YAML/JSON format
- `campaign-status` tool for querying campaign execution state
- `campaign-start` and `campaign-stop` tools for controlling campaign execution
- `campaign-update` tool for modifying existing campaigns
- `campaign-retry` tool for retrying failed campaign actions
- `campaign-move-next` tool for advancing campaign queue position
- `campaign-statistics` tool for campaign execution metrics
- `import-people-from-urls` tool for bulk-importing LinkedIn profiles into campaigns
- `campaign-add-action`, `campaign-remove-action`, `campaign-reorder-actions` tools for managing campaign action chains
- `campaign-exclude-list`, `campaign-exclude-add`, `campaign-exclude-remove` tools for campaign-action-level exclusion management
- `query-messages` tool for searching LinkedIn messaging history
- `scrape-messaging-history` tool for extracting full conversation threads
- `check-replies` tool for detecting new message replies
- `query-profile` tool for looking up profile data by URL or slug
- `query-profiles` tool for searching across stored profiles
- `describe-actions` tool for listing available LinkedHelper action types with configuration schemas
- `find-app` tool for detecting running LinkedHelper instances
- Campaign YAML/JSON format for portable campaign definitions
- Campaign database repository with CRUD and queue reset operations
- CampaignService for campaign lifecycle and execution management
- Action execution service for running LinkedHelper actions programmatically
- Action types catalog with advanced configuration schemas for all LinkedHelper action types
- `MessageRepository` for conversation and message database access
- `CampaignFormatError` integrated into domain error hierarchy
- URL validation for `navigateToProfile` to reject malformed LinkedIn URLs
- URL scheme validation in `CDPClient.navigate()` to reject non-HTTP(S) schemes
- Security warnings for `allowRemote` CDP parameter
- Claude Code plugin with `lhremote-mcp` skill for IDE integration
- SPDX license headers on all source files
- ESLint rule to enforce SPDX license headers on new files
- Dependency license compatibility check in CI
- CODEOWNERS for security-sensitive files
- Issue templates for bug reports and feature requests
- Dependabot configuration for automated dependency updates
- CONTRIBUTING guide with development setup instructions
- Getting started guide
- Architecture Decision Records (ADRs)
- Security documentation for localhost trust model, loopback validation, and MCP trust model
- npm provenance attestation for release publishing
- GitHub Pages documentation site built via pandoc on every CI run
- Test coverage reporting with Codecov integration and coverage thresholds

### Changed

- Replaced `better-sqlite3` with Node.js built-in `node:sqlite` module
- Extracted operations layer for 21 MCP/CLI tools, reducing duplication between CLI and MCP
- Decomposed `CampaignRepository` into focused repositories
- Enriched error reporting in `checkStatus` and CDP reconnection
- Exported `WrongPortError` from public API
- Pinned GitHub Actions to commit SHAs for supply-chain security
- Added `timeout-minutes` to all CI workflow jobs
- Moved E2E tests out of core to dedicated package
- Exported `DEFAULT_CDP_PORT` constant for consistent usage across packages
- Converted root devDependencies to pnpm workspace catalog refs
- Added `fail-fast: false` to CI matrix strategy
- Pinned npm version in release workflow
- Added license-check to release validation job

### Fixed

- Bare `parseInt` usage on `--max-results` CLI option (now uses explicit radix)
- Removed unused options from `launch-app`/`quit-app` CLI commands
- Windows compatibility for pnpm execution in CI scripts
- Explicit timer advancement for polling tests
- LIKE wildcard escaping for search queries
- Pagination for merged multi-database results in `query-profiles`

### Removed

- `visit-and-extract` tool and `ProfileService` — replaced by `query-profile` and `query-profiles` for data access, and campaign tools for automation

## [0.1.0] — 2026-02-04

### Added

- Unified `lhremote` meta-package combining CLI and MCP server into a single `lhremote` command with `mcp` subcommand
- `visit-and-extract` tool for visiting LinkedIn profiles and extracting structured data (name, positions, education, skills, emails)
- `check-status` health check tool for verifying LinkedHelper connection, running instances, and database state
- `start-instance` and `stop-instance` tools for managing LinkedHelper instances per LinkedIn account
- `launch-app`, `quit-app`, and `list-accounts` tools for application and account management
- MCP server with stdio transport for integration with Claude Desktop and other MCP clients
- CLI with human-readable and JSON output modes
- CDP client with WebSocket transport and target discovery
- SQLite database client for read-only access to LinkedHelper profile data
- Service layer for app lifecycle, launcher communication, instance management, and profile extraction
- E2E test infrastructure with real LinkedHelper integration
- Unit and integration test suites with mocked CDP protocol and headless Chromium

### Fixed

- Parallelized CDP discovery and hardened E2E test reliability
