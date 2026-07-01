// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { delay } from "../utils/index.js";
import { gatherRawProcesses, invalidateProcessCache } from "./gather-raw-processes.js";
import type { RawProcess } from "./gather-raw-processes.js";

/**
 * Known LinkedHelper binary names across platforms.
 */
export const LH_BINARY_NAMES_LOWERCASE = new Set([
  "linked-helper",
  "linked-helper.exe",
  "linkedhelper",
  "linkedhelper.exe",
]);

/**
 * How long to wait before retrying the process scan when a LinkedHelper process was found with
 * `cmdline: null` (Windows WMI occasionally returns no `CommandLine` for a process in the first
 * moment or two after it spawns). Long enough for WMI to catch up, short enough not to noticeably
 * slow down reads in the common case where this doesn't happen. Configurable via
 * `LHREMOTE_CMDLINE_RETRY_DELAY_MS` (matches the other timing knobs documented in
 * docs/instance-stability.md).
 */
function getCmdlineRetryDelayMs(): number {
  const v = process.env["LHREMOTE_CMDLINE_RETRY_DELAY_MS"];
  return v ? Number(v) : 500;
}

async function gatherOnce(): Promise<RawProcess[]> {
  const allProcs = await gatherRawProcesses().catch((): RawProcess[] => []);
  return allProcs.filter((p) => LH_BINARY_NAMES_LOWERCASE.has(p.name.toLowerCase()));
}

/**
 * Gather all running processes and filter down to the ones matching a known LinkedHelper binary
 * name, retrying once (after a short delay) if any of them was seen with `cmdline: null`.
 *
 * Every consumer that classifies LinkedHelper processes by role or extracts account identity from
 * the cmdline needs this retry: without it, a freshly-spawned instance can be misclassified (falls
 * back to the parent-PID heuristic instead of reading `--app-id`) or lose its account identity
 * entirely (`accountId: null`), which callers like `resolveInstancePort` then read as "this
 * account isn't running" even though it is — it just hadn't been WMI-classified yet.
 *
 * This used to be duplicated independently in `app-discovery.ts` (`findApp`) and
 * `process-inspector.ts` (`scanRunningInstances`/`scanOrphans`), which let the fix drift: it landed
 * in `findApp` but not in `scanRunningInstances`, so `import-people-from-urls`'s account-aware
 * instance resolution (which goes through `scanRunningInstances`) kept reporting an account as "not
 * running" under this exact race even after `find-app` was fixed. Centralizing here means any
 * future fix to this scan only needs to happen once.
 */
export async function gatherLhProcesses(): Promise<RawProcess[]> {
  const first = await gatherOnce();
  if (first.length === 0 || !first.some((p) => p.cmdline === null)) {
    return first;
  }

  await delay(getCmdlineRetryDelayMs());
  invalidateProcessCache();
  const retried = await gatherOnce();
  return retried.length > 0 ? retried : first;
}
