// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { pidToPorts } from "pid-port";

const execFileAsync = promisify(execFile);

/** Timeout for the netstat/lsof subprocess (ms). */
const COMMAND_TIMEOUT = 15_000;

/** netstat output on a busy host can be large; allow well beyond the 1 MiB default. */
const COMMAND_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Foreign-address values that identify a listening TCP socket in
 * `netstat -ano` output: `0.0.0.0:0` for IPv4 listeners, `[::]:0` for IPv6.
 * Used instead of the State column, which is localized on non-English Windows.
 */
const WINDOWS_LISTENER_FOREIGN_ADDRESSES = new Set(["0.0.0.0:0", "[::]:0"]);

/** Extract the trailing port number from an `addr:port` string, or null. */
function extractPort(address: string): number | null {
  const m = /[:.](\d+)$/.exec(address);
  if (!m?.[1]) return null;
  const port = parseInt(m[1], 10);
  return Number.isFinite(port) && port > 0 && port <= 65535 ? port : null;
}

/**
 * Parse `netstat -ano` output and return the listening TCP ports owned by `pid`.
 *
 * Each row is matched against the PID individually. This is the property that
 * `pid-port`'s `pidToPorts()` lacks: it builds a port→pid `Map` from all rows,
 * so when the same local port appears on several rows — a `LISTENING` row owned
 * by the process plus `TIME_WAIT` rows (PID 0) left behind by closed probe
 * connections against that same port — later rows overwrite the listener's
 * entry and the port silently disappears from the process's port set. That is
 * exactly what made `find-app` report a CDP-enabled launcher as "no CDP port".
 *
 * Exported for unit testing.
 */
export function parseWindowsNetstatListeners(stdout: string, pid: number): number[] {
  const ports = new Set<number>();
  for (const line of stdout.split("\n")) {
    // TCP rows: Proto, Local Address, Foreign Address, State, PID
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5) continue;
    if (columns[0]?.toUpperCase() !== "TCP") continue;
    if (!WINDOWS_LISTENER_FOREIGN_ADDRESSES.has(columns[2] ?? "")) continue;
    if (Number(columns[columns.length - 1]) !== pid) continue;
    const port = extractPort(columns[1] ?? "");
    if (port !== null) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

/**
 * Parse `lsof -F n` output (already filtered to TCP LISTEN sockets of one PID)
 * and return the listening port numbers.
 *
 * Exported for unit testing.
 */
export function parseLsofListenPorts(stdout: string): number[] {
  const ports = new Set<number>();
  for (const line of stdout.split("\n")) {
    // Field output: `p<pid>`, `f<fd>`, `n<name>` — only name lines carry the address.
    if (!line.startsWith("n")) continue;
    const port = extractPort(line.trim());
    if (port !== null) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

/**
 * List the TCP ports a process is LISTENING on, sorted ascending.
 *
 * Replaces `pid-port`'s `pidToPorts()` for CDP-port discovery, fixing two of
 * its problems:
 *
 * 1. Its port→pid map inversion loses ports whose number appears on more than
 *    one netstat row (see {@link parseWindowsNetstatListeners}).
 * 2. It returns local ports of *all* connections — including ephemeral
 *    client-side ports of established connections — while CDP discovery only
 *    ever cares about listeners.
 *
 * On Windows this parses `netstat -ano` (always available); on macOS/Linux it
 * uses `lsof`, falling back to `pidToPorts()` only when `lsof` itself cannot
 * run (a lossy result beats none).
 *
 * @throws when no enumeration strategy could produce a result.
 */
export async function listListeningTcpPorts(pid: number): Promise<number[]> {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new TypeError(`Expected a positive integer PID, got ${String(pid)}`);
  }

  if (process.platform === "win32") {
    const { stdout } = await execFileAsync("netstat", ["-ano"], {
      timeout: COMMAND_TIMEOUT,
      maxBuffer: COMMAND_MAX_BUFFER,
      windowsHide: true,
    });
    return parseWindowsNetstatListeners(stdout, pid);
  }

  try {
    const { stdout } = await execFileAsync(
      "lsof",
      ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", String(pid), "-F", "n"],
      { timeout: COMMAND_TIMEOUT, maxBuffer: COMMAND_MAX_BUFFER },
    );
    return parseLsofListenPorts(stdout);
  } catch (error) {
    // lsof exits 1 when the PID has no matching sockets — an empty result,
    // not a failure. Parse whatever it printed (usually nothing).
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code !== "ENOENT" &&
      typeof (error as { stdout?: unknown }).stdout === "string"
    ) {
      return parseLsofListenPorts((error as { stdout: string }).stdout);
    }

    // lsof unavailable (minimal Linux images) — fall back to pid-port despite
    // the inversion caveat documented above.
    const ports = await pidToPorts(pid);
    return [...ports].sort((a, b) => a - b);
  }
}
