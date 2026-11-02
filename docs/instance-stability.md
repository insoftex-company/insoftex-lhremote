# Instance Stability: Launcher Queue & Readiness Model

> Added in v0.22.0

## Problem Background

LinkedHelper runs one launcher process and zero-or-more account instances. Each instance carries an `--app-id=<id>` flag and communicates over a dynamically assigned CDP port. Rapid lifecycle operations (back-to-back starts, parallel ensure-instances calls) caused a cascade:

1. First `start` causes the launcher's CDP to blip (~2-3 s)
2. Second `start` arrives during the blip → fails with "launcher not reachable"
3. Recovery spawns a parallel reconnection path → phantom port reported
4. `ensure-instances` sees snapshot mismatch → marks instances `verified:false` even when they are actually up

The root causes were: no serialisation of launcher-touching ops, no stable readiness notion, and expensive WMI polling inside tight retry loops.

## Solutions

### 1. Launcher Operation Queue (`launcher-queue.ts`)

All write/lifecycle operations are serialised through a single module-level async promise chain (`_queueTail`). Only one operation runs at a time; all others wait.

```
op1 → [settle] → op2 → [settle] → op3 ...
```

**Settle barrier**: after each op, the queue holds for up to `LHREMOTE_SETTLE_BARRIER_TIMEOUT_MS` while:
- `resolveAppPort("launcher", ...)` — confirms the launcher CDP recovered
- (for starts only) `waitForConnectable(accountId, ...)` — confirms the new instance is connectable

Both steps are best-effort (errors swallowed). The cache is invalidated in `finally` regardless.

**Reads do not take the lifecycle queue**. Process inspection remains available during launcher recovery. Launcher reads such as `list-accounts`, and the best-effort launcher probe in `check-status`, take a serialized launcher session lease. Database queries with explicit account selection can work offline; automatic account selection can require launcher discovery.

### 2. Instance Readiness Model (`instance-readiness.ts`)

A process-scoped singleton `InstanceReadinessTracker` maps each PID to one of four states:

| State | Meaning |
|-------|---------|
| `connectable` | CDP port is reachable and responding |
| `starting` | Not yet seen connectable; still initializing |
| `degraded` | Was connectable; now unreachable but within the grace window |
| `stuck` | Unreachable past the grace window — needs intervention |

The tracker remembers two sets per PID:
- `seenConnectable`: PIDs ever observed as connectable
- `unreachableSince`: timestamp when the PID first became non-connectable

**State machine logic on each update**:

```
connectable?    → state = "connectable"  (clear unreachableSince entry)
not connectable:
  elapsed ≥ graceWindowMs   → state = "stuck"
  seenConnectable           → state = "degraded"
  otherwise                 → state = "starting"
```

Stale PIDs (no longer in the scan) are pruned automatically. `invalidate(pid)` clears history for a single PID (used after restart).

### 3. `waitForConnectable(accountId, opts)`

Polls until the target account's instance is connectable, using a two-path strategy:

1. **Cheap path** (when `knownPort` is supplied): `isCdpPort(knownPort)` — an HTTP `/json/list` probe that validates a CDP target array, without WMI.
2. **Full scan path**: `scanRunningInstances()` — full WMI inspection. Used when cheap path fails or no known port.

Returns `WaitForConnectableResult { cdpPort, pid, verified }`. `verified:false` means the deadline was reached without observing the account as connectable.

### 4. Process Inspection Cache (`gather-raw-processes.ts`)

`gatherRawProcesses()` caches its result for `LHREMOTE_INSPECTION_CACHE_TTL_MS` (default 1 500 ms), measured from scan completion. Concurrent callers share one scan. Invalidating the cache prevents an older in-flight scan from overwriting newer data. Windows command lines are read using bounded, hidden PowerShell/CIM calls with UTF-8 output and a 16 MiB output limit. The cache is invalidated:

- In `withLauncherQueue`'s `finally` block (after every lifecycle op)
- In `waitForPidExit` before each poll iteration
- In `findApp` when it retries after a `cmdline: null` sighting (see below)

### 4a. `cmdline: null` retry (`gather-lh-processes.ts`)

Windows WMI's `Win32_Process.CommandLine` can come back `null` for a process in the first moment
or two after it spawns, before the next scan probes it. Without a cmdline:

- Role classification falls back to a parent-PID heuristic instead of reading `--app-id=`.
- CDP-port discovery falls back to probing every TCP port the process holds, reporting whichever
  port answered (or, if none did, the first one seen) as if it were the identified CDP port. Since
  `pidToPorts()` result ordering isn't guaranteed stable across scans, this made the same PID's
  reported CDP port appear to change between two `find-app` calls a moment apart.
- Account identity resolves to `accountId: null` (`parseIdentityFromCmdline("")` has nothing to
  parse), so the process can never be matched to its real account.

That last one is the more dangerous failure mode: `resolveInstancePort` (`instance-context.ts`,
used by every write-path tool that takes `--account-id`) matches running instances by account id.
If the target account's instance was still mid-spawn during the scan, it resolves as
`accountId: null`, never matches, and the caller gets `InstanceNotRunningError` — "Account `<id>`
instance is not running" — for an account that is, in fact, running.

`gatherLhProcesses()` is the single, shared implementation of "scan for LinkedHelper processes,
retrying once past this race" used by both `findApp()` (`app-discovery.ts`) and
`scanRunningInstances()` / `scanOrphans()` (`process-inspector.ts`). When it sees any matched
LinkedHelper process with `cmdline: null`, it waits `LHREMOTE_CMDLINE_RETRY_DELAY_MS` (default
500 ms), invalidates the process cache, and re-scans once — by then WMI has almost always
populated `CommandLine`. If a process still has no cmdline after the retry, both `probeProcess()`
(`app-discovery.ts`) and `probeCdp()` (`process-inspector.ts`) report `cdpPort: null` rather than
an unconfirmed port when nothing answers as CDP, so callers can tell "no signal" apart from
"unstable signal."

This used to be two independent copies of the same scan logic, one per file — the retry fix
originally landed only in `app-discovery.ts`, which fixed `find-app`'s display but left the
write-path account resolution above still vulnerable. Keeping this in one shared module means a
future fix here only has to happen once.

### 5. `waitForPidExit(pid, timeoutMs?)`

Polls `process.kill(pid, 0)` (signal-0: checks existence without sending a signal). `ESRCH` error → process is gone. `EPERM` or no error → still alive. Used by `restart-instance` and the hardened `stop-instance` to ensure the old process is fully gone before starting a replacement.

A still-live PID at the deadline raises `ServiceError`; cancellation also throws. Neither condition permits starting a replacement.

## `restart-instance` Operation Sequence

```
withLauncherQueue(
  1. scan for existing instance (accountId)
  2. if connectable && !force → return {restarted:false}
  3. launcher.stopInstance(accountId)          ← only target account
  4. waitForPidExit(oldPid)
  5. withLauncherRecovery(startInstanceWithRecovery)
  6. waitForConnectable(accountId, {knownPort})
  7. verify a new PID (a released port may legitimately be reused)
  8. return result
, settle={type:"start", accountId, launcherPort}
)
```

No other account's process is stopped or signalled. Confirmed old-PID exit and new-PID verification guard against phantom restarts.

## `ensure-instances` Two-Phase Flow

**Phase 1 (serialised through queue)**:
```
for each accountId:
  re-scan
  if connectable → mark already_running, skip
  withLauncherQueue(startInstanceWithRecovery, settle={type:"start"})
```

**Phase 2 (parallel verification)**:
```
Promise.all(unverifiedAccounts.map(a => waitForConnectable(a.accountId, {knownPort})))
```

Phase 2 gives every account the full connectable timeout to settle after the queue chain finishes. An account whose process never appears (unlicensed) is reported as `status:"failed"` with a clear reason.

## Read vs Write Reliability Boundary

| Operation category | Launcher CDP required? | Queued? |
|-------------------|------------------------|---------|
| `check-status`, `find-app` | No | No |
| `query-profiles`, `query-messages`, etc. | No | No |
| `start-instance`, `stop-instance`, `restart-instance` | Yes | Yes |
| `launch-app`, `quit-app` | Yes | Yes |
| `list-accounts` | Yes | Session lease only |
| `ensure-instances` (Phase 1) | Yes | Yes (per account) |
| `ensure-instances` (Phase 2, `waitForConnectable`) | No | No |

Process inspection works during launcher recovery. Launcher reads may wait for a session lease; writes wait for the lifecycle queue and the settle barrier. `check-status` also attempts a best-effort launcher probe.

## Configuration Knobs

All timing constants have sane defaults and are overridable via environment variables:

| Env var | Default | Rationale |
|---------|---------|-----------|
| `LHREMOTE_GRACE_WINDOW_MS` | `30000` | 30 s covers typical LinkedHelper re-bind time on slow machines |
| `LHREMOTE_CONNECTABLE_TIMEOUT_MS` | `45000` | 45 s: grace + overhead for slow starts |
| `LHREMOTE_CONNECTABLE_INTERVAL_MS` | `1500` | Matches cache TTL — no faster polling than cache refresh |
| `LHREMOTE_SETTLE_BARRIER_TIMEOUT_MS` | `30000` | Same as grace window; after 30 s the next op won't benefit from more waiting |
| `LHREMOTE_INSPECTION_CACHE_TTL_MS` | `1500` | Amortises WMI cost across poll loops without becoming stale |
| `LHREMOTE_LAUNCHER_RECOVERY_TIMEOUT_MS` | `60000` | Cap for auto-reconnect on CDP drop |
| `LHREMOTE_CMDLINE_RETRY_DELAY_MS` | `500` | Wait before re-scanning when a LinkedHelper process was seen with `cmdline: null` (WMI hasn't populated `CommandLine` yet for a just-spawned process) |

Reduce all values in integration test environments to speed up test runs. Increase `LHREMOTE_CONNECTABLE_TIMEOUT_MS` on machines with very slow disk/startup (e.g. under heavy I/O load).

## `check-status` Readiness Field

`check-status` now includes `readiness` on each instance entry:

```json
{
  "instances": [
    {
      "accountId": 42,
      "cdpPort": 55001,
      "connectable": true,
      "readiness": "connectable"
    }
  ]
}
```

Use `readiness` to distinguish `starting` (normal initialisation) from `stuck` (needs `restart-instance`). Do not restart on `degraded` — wait out the grace window first.

## Windows startup helpers

`scripts/launch-linkedhelper.cmd` and `launch-linkedhelper-silent.cmd` invoke the adjacent `launch-linkedhelper.ps1` through Windows PowerShell. Keep these files together. Paths containing spaces are quoted; the executable is discovered from the current user's installation or `LINKEDHELPER_PATH`. `CDP_PORT` defaults to 9222. Direct PowerShell invocation also accepts `-Port`, `-LinkedHelperPath`, `-WaitSeconds` (default 60), and `-Silent`.

The helper takes a per-session, per-port startup mutex. Existing LinkedHelper processes are given time to recover; the helper never automatically kills them. Success requires both a launcher command line declaring the requested port and a valid CDP response. Silent mode writes to `%TEMP%\lh-cdp-startup.log`; interactive mode also runs `list-accounts`. Failure exits with code 2. Use `launch-app --force` only when deliberately restarting the entire application.

### Windows TCP-provider compatibility

On some Windows systems, `Get-NetTCPConnection` exposes a live TCP listener with raw state zero. `netstat -ano` omits that socket and `Get-NetTCPConnection -State Listen` also filters it out. Account runners may already expose a working dynamic CDP endpoint while `find-app` reports no port. Absence of `--remote-debugging-port` on an account runner's command line does not establish that CDP is disabled.

When netstat finds no listeners for a PID or fails, lhremote queries `Get-NetTCPConnection -OwningProcess <pid>` and selects wildcard remote addresses (`0.0.0.0` or `::`) with remote port zero. It validates and deduplicates the returned ports, then the existing discovery code probes `/json/list` before marking an instance connectable. The fallback does not start/stop processes, modify LinkedHelper files, or change account settings. Both enumeration commands are hidden and bounded to 15 seconds each.

The reverse lookup used by legacy instance discovery also queries the TCP provider on Windows, filtering by local port and the same listener endpoint fields. An absent or ambiguous owner returns no PID. Other platforms retain their existing `pid-port` lookup.

### Local deployment and MCP clients

The production package can be deployed to `~/scripts/lhremote/` with the adjacent `scripts/lhremote.cmd` and `scripts/lhremote.ps1` wrappers. Keep the three `launch-linkedhelper` CMD/PowerShell files together; the optional VBS wrapper resolves its sibling silent CMD without a hardcoded user path. Do not replace the other CRM scripts or their `package.json` when deploying lhremote.

The Insoftex package is `@insoftex/lhremote`. A client configured with `npx lhremote mcp` can run a cached, unscoped upstream package instead. Configure local clients with the absolute Node executable and `C:/Users/<user>/scripts/lhremote/dist/cli.js`, followed by `mcp`. Reconnect the client after updating an already running MCP server. Release `0.28.0` includes the Windows discovery and native startup fixes; retain the deployment manifest for the exact source commit and runtime hashes.

### Workspace-aware account startup

On launchers exposing `runningLi.startLinkedInAccountLocal`, lhremote uses that native frontend workflow. It selects and downloads the workspace-compatible instance version and supplies workspace/cloud parameters before starting the runner. Reconstructing only the older `mainWindow.startInstance` arguments can select an incompatible bundled runner and fail with a newer-database-schema error. Native workflow failures are surfaced without retrying the legacy argument shape. Already-running/starting state keeps the existing recovery path, and automatic campaign startup remains disabled. Older launchers without the native method retain the legacy startup implementation.
