// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { scanRunningInstances } from "../cdp/index.js";
import { errorMessage } from "../utils/error-message.js";
import { startInstanceWithRecovery } from "./instance-lifecycle.js";
import type { LauncherService } from "./launcher.js";

/** Per-account result from {@link ensureInstances}. */
export interface EnsureInstanceResult {
  accountId: number;
  status:
    | "already_running"
    | "started"
    | "failed"
    | "timeout";
  cdpPort?: number;
  pid?: number;
  verified?: boolean;
  error?: string;
}

/**
 * Bring up exactly the requested set of account instances (F6).
 *
 * For each `accountId`:
 * - If already verified-running (connectable instance with matching `accountId`
 *   from process inspection), skips it and records `"already_running"`.
 * - Otherwise, starts it via `startInstanceWithRecovery` with full verification.
 *
 * Instances are started one at a time with verification between each, so
 * errors are isolated per account and the rest still proceed.
 *
 * @param accountIds - The set of account IDs that should be running.
 * @param launcher - An already-connected {@link LauncherService} instance.
 * @param launcherPort - The launcher's CDP port (needed for port discovery).
 * @returns Per-account result table.
 */
export async function ensureInstances(
  accountIds: number[],
  launcher: LauncherService,
  launcherPort: number,
): Promise<EnsureInstanceResult[]> {
  const results: EnsureInstanceResult[] = [];

  for (const accountId of accountIds) {
    // Re-scan before each start so we pick up instances that just came up
    const running = await scanRunningInstances().catch(() => []);
    const alreadyRunning = running.find(
      (i) => i.accountId === accountId && i.connectable,
    );

    if (alreadyRunning) {
      const entry: EnsureInstanceResult = {
        accountId,
        status: "already_running",
        pid: alreadyRunning.pid,
        verified: true,
      };
      if (alreadyRunning.cdpPort !== null) entry.cdpPort = alreadyRunning.cdpPort;
      results.push(entry);
      continue;
    }

    try {
      const outcome = await startInstanceWithRecovery(
        launcher,
        accountId,
        launcherPort,
      );

      if (outcome.status === "timeout") {
        results.push({ accountId, status: "timeout" });
      } else {
        const entry: EnsureInstanceResult = {
          accountId,
          status: outcome.status === "already_running" ? "already_running" : "started",
          cdpPort: outcome.port,
        };
        if (outcome.pid !== undefined) entry.pid = outcome.pid;
        if (outcome.verified !== undefined) entry.verified = outcome.verified;
        results.push(entry);
      }
    } catch (error: unknown) {
      results.push({
        accountId,
        status: "failed",
        error: errorMessage(error),
      });
    }
  }

  return results;
}
