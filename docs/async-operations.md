# Async Operations

lhremote v0.23.0 introduces an async operation model for long-running MCP tools.  Tools that
may take more than a few seconds (launcher interactions, instance lifecycle commands) return
immediately with either a final result or an in-progress token that the caller polls.

## How it works

Every qualifying tool is wrapped with `runAsyncOp` (in `packages/mcp/src/operation-registry.ts`):

1. **2-second grace window** — the work function runs.  If it finishes within 2 s the result
   is returned synchronously, exactly as before.
2. **Slow path** — if the work is still running after 2 s, the function returns immediately:
   ```json
   { "status": "in_progress", "operationId": "op_abc123" }
   ```
   The work continues in the background until it completes, fails, or is cancelled.

## Operation lifecycle

```
created → in_progress → completed
                      ↘ failed
                      ↘ cancelled
```

Operations are kept in memory with a **10-minute TTL**.  After expiry they are no longer
accessible via `get-operation`.

## Management tools

### `get-operation`

Poll a running or completed operation.

```json
{ "operationId": "op_abc123" }
```

Returns one of:
```json
{ "status": "in_progress", "operationId": "op_abc123" }
{ "status": "completed",   "operationId": "op_abc123", "result": "..." }
{ "status": "failed",      "operationId": "op_abc123", "error":  "..." }
{ "status": "cancelled",   "operationId": "op_abc123" }
```

### `cancel-operation`

Request cancellation of a running operation.

```json
{ "operationId": "op_abc123" }
```

Cancellation is cooperative — the work function receives an `AbortSignal` that is aborted
immediately.  Operations that don't poll the signal (e.g. a single CDP call with no internal
loop) may not terminate early; they will still be marked `cancelled` once they return.

### `list-operations`

Enumerate all active and recently completed operations.  Returns an array of operation
summaries with `operationId`, `kind`, `status`, and `startedAt`.

```json
[
  { "operationId": "op_abc123", "kind": "restart-instance", "status": "in_progress", "startedAt": "2026-06-23T12:34:56Z" },
  { "operationId": "op_def456", "kind": "start-instance",   "status": "completed",   "startedAt": "2026-06-23T12:34:00Z" }
]
```

## Single-writer semantics

Only one mutating operation (any tool except read-only tools like `list-accounts`, `check-status`,
etc.) may be active at a time.  If a second mutating call arrives while one is in progress, it
is rejected immediately with a descriptive error naming the active operation and its ID.

This prevents race conditions around launcher state (start/stop/restart ordering, port
assignment) without requiring external locking.

## MCP progress and cancellation

When a tool is called with a `progressToken` in the MCP request, progress messages emitted
during the work function are forwarded as `notifications/progress` to the caller.

The MCP `notifications/cancelled` message for the originating request is wired to the same
`AbortSignal` as operation cancellation — so either mechanism (MCP protocol cancellation or
`cancel-operation` tool) aborts the work function.

## Security constraints

- Secret fields (`encryptedPassword`, proxy credentials, Sentry DSN) are never included in
  operation results or progress messages — the same redaction allowlist that applies to tool
  outputs applies to `get-operation` responses.
- `restart-instance` never touches processes belonging to other LinkedIn accounts — account
  isolation is enforced before any OS-level operation.
- CDP ports are dynamic; they are re-derived on each recovery attempt rather than cached.

## Recommended polling pattern

```javascript
let result = await mcp.call("restart-instance", { accountId: 42 });

while (result.status === "in_progress") {
  await new Promise(r => setTimeout(r, 1000)); // wait 1 s
  result = await mcp.call("get-operation", { operationId: result.operationId });
}

if (result.status === "failed") throw new Error(result.error);
console.log(result.result);
```
