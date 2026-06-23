// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Restart a single LinkedHelper instance cleanly (T3).
 *
 * The operation is serialised through the launcher queue so it never
 * overlaps another lifecycle op, and it only ever touches the target
 * account's process — all other instances keep running.
 */

import { scanRunningInstances, withLauncherQueue, waitForConnectable } from "../cdp/index.js";
import { startInstanceWithRecovery, waitForPidExit } from "./instance-lifecycle.js";
import { withLauncherRecovery } from "./launcher-recovery.js";
import type { LauncherService } from "./launcher.js";

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
 * Sequence (all inside the launcher queue):
 *   1. Scan for the current instance — if connectable and `force` is false,
 *      return immediately with `restarted: false` (idempotent).
 *   2. Stop the target via the launcher (with auto-recovery on launcher drop).
 *   3. Poll until the old PID has fully exited.
 *   4. Start the target via {@link startInstanceWithRecovery}.
 *   5. `waitForConnectable` until the new instance is live on a distinct port.
 *   6. Confirm new process `--app-id` matches `accountId`.
 *
 * Only the target account's process is touched.  Other instances' processes
 * and campaigns are never terminated.
 *
 * @param launcher     - Already-connected {@link LauncherService}.
 * @param accountId    - Account to restart.
 * @param launcherPort - Launcher CDP port (needed for port discovery).
 * @param options      - Optional overrides.
 */
export async function restartInstance(
  launcher: LauncherService,
  accountId: number,
  launcherPort: number,
  options?: RestartInstanceOptions,
): Promise<RestartInstanceResult> {
  const force = options?.force ?? false;

  return withLauncherQueue(
    async () => {
      let launcherRecovered = false;

      // --- Step 1: Idempotency guard ---
      const initial = await scanRunningInstances();
      const existing = initial.find(
        (i) => i.accountId === accountId && i.connectable,
      );

      if (existing && !force) {
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

      const oldPid =
        initial.find((i) => i.accountId === accountId)?.pid;

      // --- Step 2: Stop the target ---
      try {
        const { launcherRecovered: stopRecovered } = await withLauncherRecovery(
          launcher,
          () => launcher.stopInstance(accountId),
        );
        launcherRecovered = stopRecovered;
      } catch {
        // Stop failure is non-fatal — the instance may already be gone.
        // Proceed to the exit-wait and start.
      }

      // --- Step 3: Wait for old PID to exit ---
      if (oldPid !== undefined) {
        await waitForPidExit(oldPid, undefined, options?.signal);
      }

      // --- Step 4: Issue the start command ---
      // The start command needs the launcher CDP, but verification (step 5)
      // is pure process inspection and tolerates launcher CDP drops.
      // Two failure modes are possible here:
      //   (a) `startInstanceWithRecovery` returns `{status:"timeout"}` because
      //       `discoverInstancePort` cannot find the launcher after it hops ports.
      //       The start command WAS accepted; verification will confirm this.
      //   (b) `withLauncherRecovery` throws because the launcher CDP never
      //       recovered within budget.  The start may or may not have been
      //       accepted; process inspection is the arbiter.
      // In both cases fall through to step 5 — never return early on launcher state.
      let startCommandIssued = false;
      let knownPort: number | undefined;

      try {
        const { result: outcome, launcherRecovered: startRecovered } =
          await withLauncherRecovery(
            launcher,
            // Use launcher.currentPort (not the snapshot captured at call time) so
            // that if the launcher port hopped during recovery the fresh port is used.
            () => startInstanceWithRecovery(launcher, accountId, launcher.currentPort),
            options?.signal !== undefined ? { signal: options.signal } : undefined,
          );
        launcherRecovered = launcherRecovered || startRecovered;
        startCommandIssued = true;
        if (outcome.status !== "timeout") {
          knownPort = outcome.port;
        }
      } catch {
        // Launcher CDP dropped while issuing the start command and did not
        // recover within budget.  The command may or may not have been
        // accepted — process inspection in step 5 is the ground truth.
        launcherRecovered = true;
      }

      // --- Step 5 & 6: Verify via process inspection (launcher-independent) ---
      // waitForConnectable uses scanRunningInstances internally: no launcher
      // CDP required.  This succeeds even while launcher.reachable === false.
      const waitResult = await waitForConnectable(accountId, {
        ...(options?.connectableTimeoutMs !== undefined
          ? { timeoutMs: options.connectableTimeoutMs }
          : {}),
        ...(knownPort !== undefined ? { knownPort } : {}),
        ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      });

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
    // Settle barrier: launcher reachable + new instance connectable.
    { type: "start", accountId, launcherPort },
  );
}
