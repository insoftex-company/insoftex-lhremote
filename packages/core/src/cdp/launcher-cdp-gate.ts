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
 * All code that opens a launcher CDP connection MUST wrap the full
 * acquire → use → disconnect cycle in {@link withLauncherCDPGate} so that
 * at most one such session is open at any moment.
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

/** Tail of the promise chain — the next acquire blocks on this. */
let _gateTail: Promise<void> = Promise.resolve();

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
  let resolveGate!: () => void;
  const gate = new Promise<void>((r) => {
    resolveGate = r;
  });
  const prev = _gateTail;
  _gateTail = gate;

  // Block until the previous session has finished.
  await prev;

  try {
    return await op();
  } finally {
    resolveGate();
  }
}
