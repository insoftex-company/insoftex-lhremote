// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Async operation model for long-running launcher lifecycle operations.
 *
 * Write ops (start/stop/restart/ensure-instances/launch-app/quit-app) may take
 * 30–60 s when the launcher CDP hops ports or an instance is slow to start.
 * Running them synchronously blocks the MCP connection for the whole duration.
 *
 * This module provides:
 *   - OperationRegistry   — tracks in-memory state (status, progress, result)
 *   - runAsyncOp()        — 2 s grace window; fast no-ops return synchronously,
 *                           slow ops return { status:"in_progress", operationId }
 *   - operationRegistry   — process-scoped singleton
 *
 * Single-writer semantics: at most one write op runs at a time. A new op request
 * while one is running returns { status:"rejected" } with the active op's ID.
 * Use cancel-operation to abort a running op.
 *
 * TTL: completed/failed/cancelled ops are pruned from memory after 10 minutes.
 */

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Which lifecycle operation this record represents. */
export type OperationKind =
  | "start-instance"
  | "stop-instance"
  | "restart-instance"
  | "ensure-instances"
  | "launch-app"
  | "quit-app";

/** Lifecycle state of an operation. */
export type OperationStatus = "running" | "succeeded" | "failed" | "cancelled";

/** A single progress message emitted by the operation. */
export interface ProgressEntry {
  at: string;   // ISO 8601 timestamp
  message: string;
}

/** Public-facing operation snapshot (no AbortController). */
export interface OperationRecord {
  operationId: string;
  kind: OperationKind;
  status: OperationStatus;
  startedAt: string;   // ISO 8601
  finishedAt?: string; // ISO 8601, set when status leaves "running"
  progress: ProgressEntry[];
  result?: unknown;    // final result on success
  error?: string;      // error message on failure
}

/** Return type of {@link runAsyncOp}. */
export type AsyncOpOutcome<T> =
  | { status: "completed"; result: T }
  | { status: "in_progress"; operationId: string; kind: OperationKind; startedAt: string }
  | { status: "rejected"; reason: string };

// ---------------------------------------------------------------------------
// Internal record (keeps AbortController private)
// ---------------------------------------------------------------------------

interface InternalRecord extends OperationRecord {
  abortController: AbortController;
}

// ---------------------------------------------------------------------------
// OperationRegistry
// ---------------------------------------------------------------------------

const TTL_MS = 10 * 60 * 1000; // 10 minutes

export class OperationRegistry {
  private readonly records = new Map<string, InternalRecord>();

  /** Retrieve a public snapshot of an operation by ID. */
  get(operationId: string): OperationRecord | undefined {
    const r = this.records.get(operationId);
    if (!r) return undefined;
    return this.toPublic(r);
  }

  /** The currently running write op, or undefined. */
  getActiveWriteOp(): OperationRecord | undefined {
    for (const r of this.records.values()) {
      if (r.status === "running") return this.toPublic(r);
    }
    return undefined;
  }

  /**
   * Register a new operation.
   *
   * Returns the operationId, the AbortSignal for work cancellation,
   * and a `progress` function to record progress messages.
   */
  create(kind: OperationKind): {
    operationId: string;
    signal: AbortSignal;
    progress: (message: string) => void;
  } {
    this.cleanup();

    const operationId = `op_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const abortController = new AbortController();
    const startedAt = new Date().toISOString();

    const record: InternalRecord = {
      operationId,
      kind,
      status: "running",
      startedAt,
      progress: [],
      abortController,
    };
    this.records.set(operationId, record);

    const progress = (message: string): void => {
      const r = this.records.get(operationId);
      if (r?.status === "running") {
        r.progress.push({ at: new Date().toISOString(), message });
      }
    };

    return { operationId, signal: abortController.signal, progress };
  }

  /** Mark an operation as succeeded with the given result. */
  succeed(operationId: string, result: unknown): void {
    const r = this.records.get(operationId);
    if (r?.status === "running") {
      r.status = "succeeded";
      r.finishedAt = new Date().toISOString();
      r.result = result;
    }
  }

  /** Mark an operation as failed with an error message. */
  fail(operationId: string, error: unknown): void {
    const r = this.records.get(operationId);
    if (r?.status === "running") {
      r.status = "failed";
      r.finishedAt = new Date().toISOString();
      r.error = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Cancel a running operation.
   *
   * Fires the AbortController and marks status as "cancelled".
   * Returns `false` if the operation is not found or not running.
   */
  cancel(operationId: string): boolean {
    const r = this.records.get(operationId);
    if (!r || r.status !== "running") return false;
    r.abortController.abort();
    r.status = "cancelled";
    r.finishedAt = new Date().toISOString();
    return true;
  }

  /** List all tracked operations (running and recently completed). */
  list(): OperationRecord[] {
    return [...this.records.values()].map((r) => this.toPublic(r));
  }

  private toPublic(r: InternalRecord): OperationRecord {
    const pub = { ...r } as OperationRecord & { abortController?: AbortController };
    delete pub.abortController;
    return pub;
  }

  private cleanup(): void {
    const cutoff = Date.now() - TTL_MS;
    for (const [id, r] of this.records) {
      if (r.status !== "running" && r.finishedAt !== undefined) {
        if (new Date(r.finishedAt).getTime() < cutoff) {
          this.records.delete(id);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Process-scoped singleton
// ---------------------------------------------------------------------------

/** Process-scoped operation registry singleton. Import this in tool handlers. */
export const operationRegistry = new OperationRegistry();

// ---------------------------------------------------------------------------
// runAsyncOp — grace-window dispatcher
// ---------------------------------------------------------------------------

/**
 * Time to wait for a synchronous result before switching to async mode.
 *
 * Idempotent no-ops (instance already running) typically complete in < 200 ms;
 * returning them synchronously keeps the UX snappy. Slow ops (instance start,
 * launcher recovery) exceed this window and return { status: "in_progress" }.
 */
export const FAST_PATH_GRACE_MS = 2_000;

/**
 * Run a launcher write op with single-writer enforcement and a grace window.
 *
 * - Rejects immediately if another write op is already running.
 * - Starts the work in the background.
 * - Waits up to {@link FAST_PATH_GRACE_MS} ms for an early result.
 * - Returns `{ status: "completed", result }` if it settled in time, or
 *   `{ status: "in_progress", operationId }` if it is still running.
 *
 * The work function receives:
 *   - `signal`   — AbortSignal merged from the registry signal (cancel-operation)
 *                  and any external signal supplied via `options.signal` (e.g. MCP
 *                  request cancellation). Fires when either source aborts.
 *   - `progress` — Append a human-readable progress message to the record.
 *
 * @param registry - Typically the module-level {@link operationRegistry}.
 * @param kind     - Operation kind label for the registry record.
 * @param work     - The async work to perform.
 * @param options  - Optional external signal (e.g. `extra.signal` from MCP handler).
 */
export async function runAsyncOp<T>(
  registry: OperationRegistry,
  kind: OperationKind,
  work: (signal: AbortSignal, progress: (message: string) => void) => Promise<T>,
  options?: { signal?: AbortSignal | undefined },
): Promise<AsyncOpOutcome<T>> {
  // Single-writer check
  const active = registry.getActiveWriteOp();
  if (active) {
    return {
      status: "rejected",
      reason:
        `Operation ${active.operationId} (${active.kind}) is already running. ` +
        `Cancel it first with cancel-operation, or poll get-operation for completion.`,
    };
  }

  const { operationId, signal: registrySignal, progress } = registry.create(kind);

  // Merge registry signal + optional external (MCP) signal into one.
  // The work function always receives this merged signal.
  const controller = new AbortController();
  const merged = controller.signal;
  const forwardRegistry = () => controller.abort();
  registrySignal.addEventListener("abort", forwardRegistry, { once: true });
  const externalSignal = options?.signal;
  const forwardExternal = externalSignal ? () => controller.abort() : undefined;
  if (externalSignal && forwardExternal) {
    externalSignal.addEventListener("abort", forwardExternal, { once: true });
  }

  // Track settlement via closure (avoids double-catching typed errors).
  let settled = false;
  let settledResult: T | undefined;
  let settledError: unknown;
  let didError = false;

  // Start the work. Attach registry lifecycle hooks here (not inside the
  // closure) so they run even after runAsyncOp returns for background ops.
  const workPromise: Promise<void> = (async () => {
    try {
      const result = await work(merged, progress);
      settled = true;
      settledResult = result;
      registry.succeed(operationId, result);
    } catch (error) {
      settled = true;
      settledError = error;
      didError = true;
      if (registrySignal.aborted) {
        // cancel-operation was called — registry.cancel() already set the status.
      } else if (externalSignal?.aborted || (error instanceof Error && error.name === "AbortError")) {
        // MCP request cancelled or merged signal fired — treat as cancellation.
        // Note: aborted core functions throw domain errors (e.g. LinkedHelperUnreachableError),
        // not AbortError. Checking externalSignal.aborted is the reliable path.
        registry.cancel(operationId);
      } else {
        registry.fail(operationId, error);
      }
    } finally {
      registrySignal.removeEventListener("abort", forwardRegistry);
      if (externalSignal && forwardExternal) {
        externalSignal.removeEventListener("abort", forwardExternal);
      }
    }
  })();

  // Prevent unhandled rejection (we handle errors via settled flags).
  void workPromise;

  // Race against the grace window.
  await Promise.race([
    workPromise,
    new Promise<void>((r) => setTimeout(r, FAST_PATH_GRACE_MS)),
  ]);

  if (settled) {
    if (didError) throw settledError;
    return { status: "completed", result: settledResult as T };
  }

  // Still running — return in_progress handle.
  const record = registry.get(operationId);
  return {
    status: "in_progress",
    operationId,
    kind,
    startedAt: record?.startedAt ?? new Date().toISOString(),
  };
}
