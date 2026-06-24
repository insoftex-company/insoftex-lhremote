// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { pidToPorts, portToPid } from "pid-port";
import psList from "ps-list";
import { DEFAULT_CDP_PORT } from "../constants.js";
import { gatherRawProcesses, type RawProcess } from "./gather-raw-processes.js";
import { isCdpPort, parseCmdlineDebugPort } from "../utils/cdp-port.js";

/**
 * Discover the dynamic CDP port of a running LinkedHelper instance process.
 *
 * LinkedHelper spawns a separate Electron process for each LinkedIn account.
 * That process listens for CDP connections on a dynamic port that changes
 * every session.  This function discovers the port cross-platform using
 * `pid-port` and `ps-list`.
 *
 * The heuristic is:
 * 1. Find the launcher PID by looking for a process listening on `launcherPort`.
 * 2. Find child processes of the launcher.
 * 3. Among those children, find one listening on a TCP port that is NOT the
 *    launcher port and that responds to the CDP `/json/list` endpoint.
 *
 * The instance process may listen on multiple ports (e.g. a web content
 * server and a CDP debugging server).  We probe each candidate with an
 * HTTP fetch to `/json/list` to ensure we return the actual CDP port.
 *
 * @param launcherPort - The known launcher CDP port (default 9222).
 * @returns The dynamic instance CDP port, or `null` if no running instance was found.
 */
export async function discoverInstancePort(
  launcherPort: number = DEFAULT_CDP_PORT,
): Promise<number | null> {
  const launcherPid = await findPidListeningOn(launcherPort);
  if (launcherPid === null) {
    return null;
  }

  // Use gatherRawProcesses (cross-platform, Win32_Process on Windows) so that
  // parseCmdlineDebugPort can identify the authoritative CDP port without
  // racing all sockets with Promise.any().
  const allProcs = await gatherRawProcesses().catch((): RawProcess[] => []);
  const descendantPids = findDescendantPidsFromList(allProcs, launcherPid);
  if (descendantPids.length === 0) {
    return null;
  }

  const procByPid = new Map(allProcs.map((p) => [p.pid, p]));
  const results = await Promise.all(
    descendantPids.map((pid) =>
      findCdpPort(pid, launcherPort, procByPid.get(pid)?.cmdline ?? null),
    ),
  );
  return results.find((port) => port !== null) ?? null;
}

/**
 * Find the PID of a process listening on the given TCP port.
 */
async function findPidListeningOn(port: number): Promise<number | null> {
  try {
    const pid = await portToPid({ port, host: "*" });
    return pid ?? null;
  } catch {
    return null;
  }
}

/**
 * Walk a pre-fetched process list and return all PIDs that are descendants
 * of `ancestorPid`.  Kept synchronous so callers pay the async cost once
 * (via gatherRawProcesses) rather than inside a loop.
 */
function findDescendantPidsFromList(
  processes: RawProcess[],
  ancestorPid: number,
): number[] {
  const descendants: number[] = [];
  const queue = [ancestorPid];
  const visited = new Set<number>([ancestorPid]);

  let currentPid: number | undefined;
  while ((currentPid = queue.shift()) !== undefined) {
    for (const p of processes) {
      if (p.ppid === currentPid && !visited.has(p.pid)) {
        visited.add(p.pid);
        descendants.push(p.pid);
        queue.push(p.pid);
      }
    }
  }

  return descendants;
}

/**
 * Find PIDs of all descendant processes for the given ancestor PID via psList.
 * Used only by killInstanceProcesses, which needs a fresh uncached snapshot.
 */
async function findDescendantPids(ancestorPid: number): Promise<number[]> {
  try {
    const processes = await psList();
    return findDescendantPidsFromList(
      processes.map((p) => ({ pid: p.pid, ppid: p.ppid ?? 0, name: p.name, cmdline: null })),
      ancestorPid,
    );
  } catch {
    return [];
  }
}

/**
 * Find the CDP debugging port for the given PID.
 *
 * When cmdline contains `--remote-debugging-port=<N>`, that port is probed
 * directly — Electron binds multiple sockets and racing them with Promise.any()
 * is non-deterministic.  Falls back to port-racing only when no cmdline hint
 * is available (e.g. Win32_Process query unavailable).
 */
async function findCdpPort(
  pid: number,
  excludePort: number,
  cmdline: string | null,
): Promise<number | null> {
  // Cmdline-authoritative path: trust the declared port, skip socket racing.
  if (cmdline !== null) {
    const cmdlinePort = parseCmdlineDebugPort(cmdline);
    if (cmdlinePort !== null) {
      if (cmdlinePort === excludePort) return null; // this process IS the launcher
      return (await isCdpPort(cmdlinePort)) ? cmdlinePort : null;
    }
  }

  // Fallback: probe all TCP ports when cmdline hint is unavailable.
  let ports: Set<number>;
  try {
    ports = await pidToPorts(pid);
  } catch {
    return null;
  }

  const candidates = [...ports].filter((p) => p !== excludePort);
  if (candidates.length === 0) {
    return null;
  }

  try {
    return await Promise.any(
      candidates.map(async (port) => {
        if (await isCdpPort(port)) {
          return port;
        }
        throw new Error("not CDP");
      }),
    );
  } catch {
    return null;
  }
}

/**
 * Find and forcefully kill all instance child processes of the launcher.
 *
 * Use as a last resort when graceful `stopInstance()` fails and
 * the instance process needs to be terminated at the OS level.
 */
export async function killInstanceProcesses(
  launcherPort: number,
): Promise<void> {
  const launcherPid = await findPidListeningOn(launcherPort);
  if (launcherPid === null) {
    return;
  }

  const descendantPids = await findDescendantPids(launcherPid);
  for (const pid of descendantPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process may already be dead
    }
  }
}
