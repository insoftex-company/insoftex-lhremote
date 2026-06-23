// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Restart a single LinkedHelper instance cleanly (T3).
 *
 * The launcher CDP connection is held only for the individual stop and start
 * RPCs — released between them and never held across the process-inspection
 * waits (PID exit, connectable poll).  This shrinks the contention window
 * from minutes to seconds and allows concurrent read operations (list-accounts)
 * to proceed without colliding.
 *
 * The operation is serialised through the launcher queue so it never overlaps
 * another lifecycle op, and it only ever touches the target account's process —
 * all other instances keep running.
 *
 * Lock ordering:
 *   launcher-queue (write-op exclusive) → launcher-CDP-gate (session-scoped)
 *
 * A write op holds the queue slot and then acquires the CDP gate for each RPC
 * (stop, then start), releasing between acquisitions.  Reads acquire only the
 * gate — no queue slot.  No circular dependency → no deadlock.
 */

import { scanRunningInstances, waitForConnectable, withLauncherCDPGate, withLauncherQueue } from "../cdp/index.js";
import { startInstanceWithRecovery, waitForPidExit } from "./instance-lifecycle.js";
import { acquireLauncherWithRecovery, withLauncherRecovery } from "./launcher-recovery.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for {@link restartInstance}. */
export interface RestartInstanceOptions {
  /**
   * Restart even when the instance is already connectable.
   * Default: `false` — healthy instances are skipped (idempotent).
   */
  force?: boolean;
  /**
   * Override the `waitForConnectable` timeout (ms).
   * Default: LHREMOTE_CONNECTABLE_TIMEOUT_MS (45 000).
   */
  connectableTimeoutMs?: number;
  /**
   * Cancellation signal.  When fired, in-progress waits (PID exit,
   * connectable polling) stop early and the operation returns with whatever
   * state process inspection can determine at that moment.
   */
  signal?: AbortSignal;
  /**
   * Progress callback — called at each sub-step with a human-readable message.
   * Timestamps are appended by the registry; callers do not need to include them.
   */
  progress?: (message: string) => void;
}

/** Result returned by {@link restartInstance}. */
export interface RestartInstanceResult {
  accountId: number;
  /** `true` when the instance was actually stopped and restarted. */
  restarted: boolean;
  /** PID of the old process (before restart), if one was running. */
  oldPid: number | undefined;
  /** PID of the new process after restart. */
  newPid: number | undefined;
  /** CDP port of the new process, or `null` on failure. */
  cdpPort: number | null;
  /**
   * `true` when the new process's `--app-id` matches `accountId` AND it is
   * connectable on a distinct port (not a phantom/duplicate).
   * `false` if verification failed or timed out.
   */
  verified: boolean;
  /** Whether the launcher CDP connection dropped and was auto-recovered. */
  launcherRecovered: boolean;
  /**
   * Human-readable note when the op completed in a degraded state, e.g.
   * when the launcher CDP did not recover within budget but process
   * inspection still determined the instance state.
   */
  note?: string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Restart a single LinkedHelper account instance.
 *
 * Sequence:
 *   1. Scan for the current instance — if connectable and `force` is false,
 *      return immediately with `restarted: false` (idempotent).
 *   2. Acquire launcher CDP gate → stop the target → release gate.
 *   3. Poll until the old PID has fully exited (process-inspection, no launcher).
 *   4. Acquire launcher CDP gate → start the target → release gate.
 *   5. `waitForConnectable` until the new instance is live (process-inspection,
 *      no launcher held).
 *   6. Confirm new process `--app-id` matches `accountId`.
 *
 * Only the target account's process is touched.  Other instances' processes
 * and campaigns are never terminated.
 *
 * @param cdpPort     - Launcher CDP port override (auto-discovered when undefined).
 * @param cdpOptions  - CDP connection options (`host`, `allowRemote`).
 * @param accountId   - Account to restart.
 * @param options     - Optional overrides including `force`, signal, and progress.
 */
export async function restartInstance(
  cdpPort: number | undefined,
  cdpOptions: { host?: string; allowRemote?: boolean },
  accountId: number,
  options?: RestartInstanceOptions,
): Promise<RestartInstanceResult> {
  const force = options?.force ?? false;
  const signal = options?.signal;
  const emit = options?.progress ?? (() => {});

  return withLauncherQueue(
    async () => {
      let launcherRecovered = false;

      // --- Step 1: Idempotency guard (process inspection only, no launcher) ---
      emit("scanning-instances");
      const initial = await scanRunningInstances();
      const existing = initial.find(
        (i) => i.accountId === accountId && i.connectable,
      );

      if (existing && !force) {
        emit("already-connectable — skipping restart");
        return {
          accountId,
          restarted: false,
          oldPid: existing.pid,
          newPid: existing.pid,
          cdpPort: existing.cdpPort,
          verified: true,
          launcherRecovered: false,
        };
      }

      const oldPid = initial.find((i) => i.accountId === accountId)?.pid;

      // --- Step 2: Stop (acquire gate → RPC → release gate) ---
      emit("acquiring-launcher (stop)");
      try {
        await withLauncherCDPGate(async () => {
          signal?.throwIfAborted?.();
          const { launcher, launcherPreRecovered: stopPreRec } =
            await acquireLauncherWithRecovery(cdpPort, cdpOptions, signal !== undefined ? { signal } : undefined);
          if (stopPreRec) launcherRecovered = true;

          emit(
            `stopping ${accountId}${oldPid !== undefined ? ` (pid ${oldPid})` : ""}`,
          );
          try {
            const { launcherRecovered: stopInFlight } = await withLauncherRecovery(
              launcher,
              () => launcher.stopInstance(accountId),
              signal !== undefined ? { signal } : undefined,
            );
            if (stopInFlight) launcherRecovered = true;
          } finally {
            launcher.disconnect();
          }
        });
      } catch {
        // Stop failure is non-fatal — the instance may already be gone.
        // Proceed to the exit-wait and start.
      }

      // --- Step 3: Wait for old PID to exit (no launcher held) ---
      if (oldPid !== undefined) {
        emit(`waiting-for-exit (pid ${oldPid})`);
        await waitForPidExit(oldPid, undefined, signal);
      }

      // --- Step 4: Start (acquire gate → RPC → release gate) ---
      // The launcher CDP is released before and after the start RPC.
      // Verification (step 5) is pure process inspection — no launcher needed.
      let startCommandIssued = false;
      let knownPort: number | undefined;

      emit("acquiring-launcher (start)");
      try {
        await withLauncherCDPGate(async () => {
          signal?.throwIfAborted?.();
          const { launcher, launcherPreRecovered: startPreRec } =
            await acquireLauncherWithRecovery(cdpPort, cdpOptions, signal !== undefined ? { signal } : undefined);
          if (startPreRec) launcherRecovered = true;

          emit(`starting ${accountId}`);
          try {
            // Use launcher.currentPort (not a snapshot) so that if the launcher
            // port hopped during recovery the fresh port is used.
            const { result: outcome, launcherRecovered: startInFlight } =
              await withLauncherRecovery(
                launcher,
                () =>
                  startInstanceWithRecovery(
                    launcher,
                    accountId,
                    launcher.currentPort,
                  ),
                signal !== undefined ? { signal } : undefined,
              );
            if (startInFlight) launcherRecovered = true;
            startCommandIssued = true;
            if (outcome.status !== "timeout") {
              knownPort = outcome.port;
            }
          } finally {
            launcher.disconnect();
          }
        });
      } catch {
        // Launcher CDP dropped while issuing the start command and did not
        // recover within budget.  The command may or may not have been
        // accepted — process inspection in step 5 is the ground truth.
        launcherRecovered = true;
      }

      // --- Steps 5 & 6: Verify via process inspection (launcher-independent) ---
      // waitForConnectable uses scanRunningInstances internally: no launcher
      // CDP required.  This succeeds even while the launcher is unreachable.
      emit("waiting-for-connectable");
      const waitResult = await waitForConnectable(accountId, {
        ...(options?.connectableTimeoutMs !== undefined
          ? { timeoutMs: options.connectableTimeoutMs }
          : {}),
        ...(knownPort !== undefined ? { knownPort } : {}),
        ...(signal !== undefined ? { signal } : {}),
      });

      emit(
        `verifying (pid ${waitResult.pid ?? "unknown"}, port ${waitResult.cdpPort ?? "none"})`,
      );

      if (!waitResult.verified) {
        return {
          accountId,
          restarted: true,
          oldPid,
          newPid: undefined,
          cdpPort: null,
          verified: false,
          launcherRecovered,
          ...(!startCommandIssued
            ? {
                note:
                  "launcher CDP dropped before start command was confirmed accepted; " +
                  "instance not found via process inspection within timeout",
              }
            : {}),
        };
      }

      // Phantom/duplicate port guard: new port must differ from the old one,
      // or the old instance must have exited (oldPid is gone).
      const distinctPort =
        waitResult.cdpPort !== null &&
        (existing === undefined ||
          waitResult.cdpPort !== existing.cdpPort ||
          oldPid === undefined);

      emit(
        distinctPort
          ? `verified — newPid ${waitResult.pid ?? "?"}, port ${waitResult.cdpPort ?? "none"}`
          : "verified=false — duplicate port detected",
      );

      return {
        accountId,
        restarted: true,
        oldPid,
        newPid: waitResult.pid,
        cdpPort: waitResult.cdpPort,
        verified: distinctPort,
        launcherRecovered,
      };
    },
    // Settle barrier: wait for launcher CDP to be reachable after the op.
    // Instance connectability is already confirmed in step 5 above.
    { type: "launcher" },
  );
}
