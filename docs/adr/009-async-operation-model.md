# ADR-009: Async Operation Model

## Status

Accepted (2026-06-23)

## Context

Launcher lifecycle operations (`start-instance`, `stop-instance`, `restart-instance`,
`ensure-instances`, `launch-app`, `quit-app`) can take 30–60 s when the launcher CDP hops
ports, an instance is slow to start, or a recovery cycle is needed.

Running these synchronously blocks the MCP connection for their full duration.  MCP 2025-11
defines `notifications/cancelled` for client-initiated cancellation and `progressToken` for
streaming progress, but neither is useful if the server holds the response socket open for a
minute at a time.

ADR-008 introduced launcher-queue serialisation (promise-chain mutex) to prevent concurrent
writes from racing.  ADR-008 noted a consequence: "The promise-chain queue is invisible: there
is no API to inspect queue depth or cancel a pending operation."  v0.23.0 closes that gap.

Four sub-problems required design decisions:

1. **Non-blocking startup (T1)** — `initialize`/`tools/list` must never block on I/O.
2. **Async dispatch (T2)** — long ops return an in-progress token; callers poll.
3. **Cancellation threading (T3)** — `AbortSignal` must reach every blocking call inside a work function.
4. **MCP protocol integration (T4)** — honour `progressToken` and `notifications/cancelled`.

## Decision

### T1 — Non-blocking startup

All tool registrations are synchronous.  `registerAllTools()` calls `server.tool(...)` for
each handler — no `await`, no `import()`, no discovery I/O.  Launcher connections are
established lazily inside each handler's work function, not at registration time.

**Why?** MCP clients send `initialize` and `tools/list` immediately after connecting and expect
fast responses.  Blocking on CDP discovery at startup delays all subsequent calls and can time
out during launcher restarts.

### T2 — Grace-window dispatcher (`runAsyncOp`)

```
runAsyncOp(registry, kind, work)
  ├─ single-writer check: reject if another op is already running
  ├─ create registry record (operationId, AbortController, startedAt)
  ├─ start work() in background
  ├─ race: wait up to FAST_PATH_GRACE_MS (2 s)
  │   ├─ if settled  → return { status: "completed", result }   (sync path)
  │   └─ if running  → return { status: "in_progress", operationId }
  └─ background promise: registry.succeed / registry.fail on completion
```

**Grace window (2 s)**: Idempotent no-ops (instance already running, app already launched)
typically resolve in < 200 ms and return synchronously.  Slow ops exceed the window and return
an in-progress token.  The 2 s value is a deliberate balance: short enough that callers don't
observe artificial latency on fast paths; long enough to capture most idempotent outcomes.

**Single-writer semantics**: At most one write op runs at a time.  A second concurrent request
receives `{ status: "rejected", reason: "Operation op_X (restart-instance) is already running…" }`.
This extends the ADR-008 promise-chain mutex with visibility: callers now know *why* their
request was deferred and can poll or cancel the active op.

**`OperationRegistry`**: In-memory map of `operationId → InternalRecord`.  Records hold an
`AbortController` (private), lifecycle state, timestamped progress messages, final result or
error, and start/finish timestamps.  10-minute TTL on completed records.

**Three management tools**:

| Tool | Purpose |
|------|---------|
| `get-operation` | Poll a running or completed operation by ID |
| `cancel-operation` | Abort a running operation; return post-cancel process snapshot |
| `list-operations` | Enumerate all active and recently completed operations |

### T3 — AbortSignal threading

`AbortSignal` was added to every blocking call in the launcher lifecycle stack:

| Function | Where |
|----------|-------|
| `resolveAppPort` | `packages/core/src/cdp/app-discovery.ts` |
| `waitForPidExit` | `packages/core/src/services/instance-lifecycle.ts` |
| `waitForConnectable` | `packages/core/src/cdp/instance-readiness.ts` |
| `LauncherService.reconnect` | `packages/core/src/services/launcher.ts` |
| `withLauncherRecovery` | `packages/core/src/services/launcher-recovery.ts` |
| `acquireLauncherWithRecovery` | `packages/core/src/services/launcher-recovery.ts` |

Each tool handler creates a local `AbortController` and wires both the operation signal and the
MCP `extra.signal` to it via a single `forward = () => controller.abort()` listener:

```typescript
const controller = new AbortController();
const merged = controller.signal;
const forward = () => controller.abort();
signal.addEventListener("abort", forward, { once: true });
if (mcpSignal) mcpSignal.addEventListener("abort", forward, { once: true });
```

The `merged` signal is passed to `acquireLauncherWithRecovery` and flows down the stack.

**Why merge at the tool layer, not inside `runAsyncOp`?** The MCP `extra.signal` is only
available inside the tool handler callback, not in `runAsyncOp`'s generic interface.  Merging
at the tool layer keeps `runAsyncOp` signal-agnostic and testable without MCP machinery.

### T4 — MCP progress and protocol cancellation

Progress messages emitted via the `progress(message)` callback inside a work function are
forwarded as `notifications/progress` to the MCP client when a `progressToken` is present in
the request.  This is wired at the tool handler level, not inside `runAsyncOp`, for the same
reason as T3 — the progress token is only available in the handler context.

`notifications/cancelled` (MCP 2025-11 §6.8) triggers `extra.signal.abort()`, which is
forwarded to the merged signal via the T3 wiring above.

## Alternatives Considered

### Streaming responses (SSE / chunked)

Return a stream and push progress events as the work progresses.  Rejected because MCP
2025-11 does not define a streaming tool response format — only synchronous results and
`notifications/progress` side-channels.  The async token + polling pattern is compatible with
every MCP client regardless of transport.

### Queue depth visible in `list-operations`

Expose pending (not-yet-started) operations as well as running ones.  Rejected because
single-writer semantics mean at most one op runs at a time, and pending ops are rejected
immediately rather than queued.  Exposing a queue would imply queuing semantics that do not
exist.

### Persistent operation store (SQLite)

Survive process restarts.  Rejected for the same reason as ADR-008's "persisted readiness
store" alternative: the MCP server process is short-lived, and persisting operation state
introduces its own consistency management.  Operations that outlive the server process would be
unreachable anyway (AbortController is in-memory), so persistence would not add correctness.

### Longer grace window (30 s)

Match the launcher discovery timeout so more ops settle synchronously.  Rejected because a
30 s grace window would block the MCP response for an observable duration on every slow op,
defeating the purpose of async dispatch.  2 s is a deliberate ceiling for "fast enough to feel
synchronous."

## Consequences

**Positive:**

- Long-running ops no longer block the MCP connection.
- Callers can cancel stuck ops via `cancel-operation` without restarting the server.
- `list-operations` gives operators visibility into what is running — previously invisible.
- `AbortSignal` threading means cancellation propagates to every blocking wait (port polling,
  PID exit, CDP connection) rather than only to the top-level promise.
- Idempotent ops (instance already running) still return synchronously, so fast paths are not
  penalised by the async model.

**Negative:**

- Callers that need the final result must poll `get-operation` — one extra round-trip for slow
  ops.
- Cancellation is cooperative.  Work functions that do not poll the signal (e.g. a single CDP
  call with no internal loop) may not terminate early; they will be marked `cancelled` only
  after they return.
- The single-writer rejection means two tools cannot run simultaneously even if they operate on
  different accounts.  This is acceptable given the launcher serialises operations itself, but
  it is more restrictive than strictly necessary.
- In-memory state is lost on server restart.  A caller polling an operation that was in
  progress when the server crashed will receive "operation not found."

**Neutral:**

- The 10-minute TTL is a pragmatic constant.  Operations older than 10 min are unlikely to be
  relevant; callers that need long-term audit trails should record results themselves.
- `FAST_PATH_GRACE_MS = 2000` is not configurable at runtime.  If the default proves wrong for
  a deployment, it can be changed at compile time.
