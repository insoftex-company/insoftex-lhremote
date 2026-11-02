// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * In-process async mutex that serializes all launcher CDP sessions (F1).
 *
 * The LinkedHelper launcher accepts only one CDP debug connection at a time.
 * Concurrent in-process sessions from the same server process (e.g.
 * list-accounts while restart-instance is in its stop phase) produce
 * CDPConnectionError because the target is already taken.
 *
 * LauncherService automatically leases this gate for connect → disconnect.
 * {@link withLauncherCDPGate} also groups recovery/RPC phases under one lease;
 * nested service sessions are serialized inside that scope.
 *
 * Lock ordering (deadlock-free):
 *   launcher-queue (write-op exclusive) → launcher-CDP-gate (session-scoped)
 *
 * Write ops hold the launcher-queue slot, then acquire the gate for each
 * individual launcher RPC (releasing between RPCs — e.g. restart-instance
 * acquires the gate once for stop, releases, then re-acquires for start).
 * Read ops (list-accounts) acquire only the gate and never the queue slot.
 * No circular dependency exists, so deadlock is impossible.
 *
 * External processes (e.g. a CLI `lhremote list-accounts`) can still connect
 * concurrently — the gate only controls in-process sessions.  External
 * contention is handled by the backoff retry in `acquireLauncherWithRecovery`.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const gateScope = new AsyncLocalStorage<{ active: boolean; sessionTail: Promise<void> }>();

/** Tail of the promise chain — the next acquire blocks on this. */
let _gateTail: Promise<void> = Promise.resolve();

/** Acquire a session lease; LauncherService releases it on disconnect or failure. */
export async function acquireLauncherCDPLease(): Promise<() => void> {
  const scope = gateScope.getStore();
  let release!: () => void;
  const previous = scope?.active ? scope.sessionTail : _gateTail;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  if (scope?.active) scope.sessionTail = next;
  else _gateTail = next;
  await previous;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      release();
    }
  };
}

/**
 * Run `op` with exclusive in-process access to a launcher CDP session.
 *
 * Callers MUST call `launcher.disconnect()` before `op` returns so that the
 * gate is released promptly and the next waiter can connect.
 *
 * @param op - Async function that opens, uses, and closes a launcher connection.
 * @returns The value returned by `op`.
 */
export async function withLauncherCDPGate<T>(op: () => Promise<T>): Promise<T> {
  if (gateScope.getStore()?.active) return op();
  const release = await acquireLauncherCDPLease();
  const scope = { active: true, sessionTail: Promise.resolve() };
  try {
    return await gateScope.run(scope, op);
  } finally {
    await scope.sessionTail;
    scope.active = false;
    release();
  }
}
