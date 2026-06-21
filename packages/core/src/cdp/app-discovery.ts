// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { pidToPorts } from "pid-port";
import psList from "ps-list";

import { LinkedHelperNotRunningError, LinkedHelperUnreachableError } from "../services/errors.js";
import { delay } from "../utils/index.js";
import { isCdpPort } from "../utils/cdp-port.js";
import { isLoopbackAddress } from "../utils/loopback.js";
import type { InstanceIdentity } from "./process-inspector.js";
import { parseIdentityFromCmdline } from "./process-inspector.js";

/**
 * Known LinkedHelper binary names across platforms.
 */
const BINARY_NAMES = [
  "linked-helper",
  "linked-helper.exe",
  "linkedhelper",
  "linkedhelper.exe",
];
const BINARY_NAMES_LOWERCASE = new Set(BINARY_NAMES.map((name) => name.toLowerCase()));

/**
 * Role of a discovered LinkedHelper process.
 *
 * - `"launcher"` — the top-level process that manages accounts and instances.
 * - `"instance"` — an account-instance main process spawned by the launcher.
 * - `"helper-child"` — a Chromium helper subprocess (gpu/renderer/utility/crashpad).
 *   These share the same binary name but have `--type=` in their command line.
 *   They never expose a CDP port and are never true instances.
 * - `"unknown"` — role could not be determined from the process tree.
 */
export type AppRole = "launcher" | "instance" | "helper-child" | "unknown";

/**
 * Result of discovering a running LinkedHelper application process.
 */
export interface DiscoveredApp {
  /** OS process ID. */
  pid: number;

  /** CDP port the process is listening on, or `null` if none detected. */
  cdpPort: number | null;

  /** Whether the CDP endpoint responded to a probe. */
  connectable: boolean;

  /**
   * Role of this process.
   *
   * Classification uses command-line analysis when available:
   * - `--type=` flag → `"helper-child"` (never a real instance).
   * - `resources[\/]out[\/]` path + `--app-id`/`--user-li-id` → `"instance"`.
   * - No `resources[\/]out[\/]` → `"launcher"`.
   * Falls back to parent-PID heuristic when command lines are unavailable.
   */
  role: AppRole;

  /**
   * Account identity resolved from the process command line.
   * Only present for `role === "instance"` processes.
   * Never contains credentials or secrets.
   */
  identity?: InstanceIdentity;
}

/**
 * Scan the system for running LinkedHelper application processes.
 *
 * For each matching process, attempts to detect a CDP debugging port
 * by inspecting its listening TCP ports and probing them with an HTTP
 * request to the CDP `/json/list` endpoint.
 *
 * Role classification uses command-line analysis when available (the
 * `--type=` flag identifies helper children; the executable path and
 * `--app-id` flag identify instance main processes), falling back to
 * the parent-PID heuristic.  Helper children (`role: "helper-child"`)
 * are included so callers can see the full process tree; they are
 * never connectable CDP endpoints.
 *
 * Account identity (`identity` field) is populated for instance main
 * processes from a security-allowlisted command-line parser.
 *
 * @returns An array of discovered LinkedHelper processes (may be empty).
 */
export async function findApp(): Promise<DiscoveredApp[]> {
  const all = await psList().catch(() => [] as Awaited<ReturnType<typeof psList>>);
  const lhProcs = all
    .filter((p) => BINARY_NAMES_LOWERCASE.has(p.name.toLowerCase()))
    .map((p) => ({
      pid: p.pid,
      ppid: p.ppid ?? 0,
      cmdline: (p as { cmd?: string }).cmd ?? null,
    }));

  if (lhProcs.length === 0) return [];

  const lhPids = new Set(lhProcs.map((p) => p.pid));
  const discovered: DiscoveredApp[] = [];

  for (const proc of lhProcs) {
    const role = classifyRole(proc, lhPids);

    if (role === "helper-child") continue;

    const app = await probeProcess(proc.pid, role);

    // Populate identity for instance processes when cmdline is available.
    // Uses an allowlist parser — no credentials or secrets are captured.
    if (role === "instance" && proc.cmdline) {
      app.identity = parseIdentityFromCmdline(proc.cmdline);
    }

    discovered.push(app);
  }

  return discovered;
}

/**
 * How long to retry when LH processes exist but CDP is unreachable (ms).
 * LH briefly drops its CDP port while reconnecting to existing instances
 * after a fresh launch — 30 s is enough to ride out that window.
 * Tests may pass 0 to disable retries and get an immediate failure.
 */
export const REACHABILITY_RETRY_TIMEOUT = 30_000;
const REACHABILITY_RETRY_INTERVAL = 1_000;

/**
 * Discover the CDP port for a running LinkedHelper process with the
 * specified role.
 *
 * Scans running processes via {@link findApp} and returns the first
 * connectable port matching the requested role. When processes are found
 * but none are connectable, retries every second for up to
 * {@link REACHABILITY_RETRY_TIMEOUT} ms (LH briefly drops its CDP port
 * while reconciling instances after a fresh launch).
 *
 * @param role - Process role to look for (`"launcher"` or `"instance"`).
 * @param retryTimeout - How long to retry when processes are found but
 *   unreachable (ms). Pass `0` for immediate failure (useful in tests or
 *   best-effort callers).
 * @returns The CDP port number.
 * @throws {LinkedHelperNotRunningError} if no LinkedHelper processes are found.
 * @throws {LinkedHelperUnreachableError} if processes are found but none are
 *   connectable with the requested role within `retryTimeout` ms.
 */
export async function resolveAppPort(
  role: "launcher" | "instance",
  retryTimeout = REACHABILITY_RETRY_TIMEOUT,
): Promise<number> {
  const deadline = Date.now() + retryTimeout;
  let lastApps: Awaited<ReturnType<typeof findApp>> = [];

  while (true) {
    const apps = await findApp();

    if (apps.length === 0) {
      throw new LinkedHelperNotRunningError();
    }

    const match = apps.find(
      (a) => a.role === role && a.connectable && a.cdpPort !== null,
    );
    if (match?.cdpPort !== null && match?.cdpPort !== undefined) {
      return match.cdpPort;
    }

    lastApps = apps;
    if (Date.now() >= deadline) break;

    // LH may be temporarily unreachable while reconciling instance state;
    // retry until the deadline rather than failing immediately.
    // eslint-disable-next-line no-await-in-loop
    await delay(REACHABILITY_RETRY_INTERVAL);
  }

  throw new LinkedHelperUnreachableError(lastApps);
}

/**
 * Resolve the instance CDP port, requiring an explicit port for non-loopback hosts.
 *
 * When {@link cdpPort} is provided it is returned as-is.  When it is
 * omitted and the host is loopback (or omitted), the port is
 * auto-discovered via {@link resolveAppPort}.  For non-loopback hosts
 * auto-discovery cannot work (it scans local processes), so an error
 * is thrown to prevent silently connecting to the wrong endpoint.
 *
 * @param cdpPort - Explicit CDP port (returned verbatim when provided).
 * @param cdpHost - Target host for the CDP connection.
 * @returns The resolved CDP port number.
 */
export async function resolveInstancePort(
  cdpPort?: number,
  cdpHost?: string,
  retryTimeout = REACHABILITY_RETRY_TIMEOUT,
): Promise<number> {
  if (cdpPort !== undefined) return cdpPort;
  if (cdpHost !== undefined && !isLoopbackAddress(cdpHost)) {
    throw new Error("cdpPort is required when using a non-loopback cdpHost — auto-discovery only works locally");
  }
  return resolveAppPort("instance", retryTimeout);
}

/**
 * Resolve the launcher CDP port, requiring an explicit port for non-loopback hosts.
 *
 * Analogous to {@link resolveInstancePort} but discovers the launcher role.
 *
 * @param cdpPort - Explicit CDP port (returned verbatim when provided).
 * @param cdpHost - Target host for the CDP connection.
 * @param retryTimeout - How long to retry when processes are found but
 *   unreachable (ms). Defaults to {@link REACHABILITY_RETRY_TIMEOUT}. Pass `0`
 *   for fast-fail behavior (health checks, best-effort probes).
 * @returns The resolved CDP port number.
 */
export async function resolveLauncherPort(
  cdpPort?: number,
  cdpHost?: string,
  retryTimeout = REACHABILITY_RETRY_TIMEOUT,
): Promise<number> {
  if (cdpPort !== undefined) return cdpPort;
  if (cdpHost !== undefined && !isLoopbackAddress(cdpHost)) {
    throw new Error("cdpPort is required when using a non-loopback cdpHost — auto-discovery only works locally");
  }
  return resolveAppPort("launcher", retryTimeout);
}

/**
 * Classify a LinkedHelper process as launcher, instance, or helper-child.
 *
 * Uses command-line analysis when available (the `--type=` flag identifies
 * helper children; the `resources/out/` path identifies instance mains).
 * Falls back to parent-PID heuristic when no command line is available.
 */
function classifyRole(
  proc: { ppid: number; cmdline: string | null },
  lhPids: Set<number>,
): AppRole {
  if (proc.cmdline) {
    if (/--type=/.test(proc.cmdline)) return "helper-child";
    if (/resources[/\\]out[/\\]/i.test(proc.cmdline)) return "instance";
    return "launcher";
  }
  return lhPids.has(proc.ppid) ? "instance" : "launcher";
}

/**
 * Probe a single process for CDP connectivity.
 */
async function probeProcess(pid: number, role: AppRole): Promise<DiscoveredApp> {
  let ports: Set<number>;
  try {
    ports = await pidToPorts(pid);
  } catch {
    return { pid, cdpPort: null, connectable: false, role };
  }

  for (const port of ports) {
    if (await isCdpPort(port)) {
      return { pid, cdpPort: port, connectable: true, role };
    }
  }

  // Process is running but no CDP port detected (or none responding)
  const firstPort = [...ports][0] ?? null;
  return { pid, cdpPort: firstPort, connectable: false, role };
}
