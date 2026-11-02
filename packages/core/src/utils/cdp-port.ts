// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/** Timeout for CDP port probe requests (ms). */
const PROBE_TIMEOUT = 3_000;

/**
 * Check whether a port exposes a CDP `/json/list` endpoint.
 */
export async function isCdpPort(port: number): Promise<boolean> {
  try {
    const response = await fetch(
      `http://127.0.0.1:${String(port)}/json/list`,
      { signal: AbortSignal.timeout(PROBE_TIMEOUT) },
    );
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Extract the `--remote-debugging-port` value from a process command line.
 *
 * Electron processes (both the LinkedHelper launcher and its account instances)
 * may bind multiple TCP sockets — the intended CDP port named here AND an
 * internal Electron DevTools socket that also responds to `/json/list`.
 * Using the cmdline flag rather than probing all sockets is the only
 * deterministic way to identify the correct CDP endpoint.
 *
 * @returns The port number, or `null` when the flag is absent or unparseable.
 */
export function parseCmdlineDebugPort(cmdline: string): number | null {
  // Accept whitespace or `"` before the flag: Windows WMI CommandLine wraps
  // args containing special characters in outer double-quotes, so the flag may
  // be preceded by `"` rather than a space (e.g. `"--remote-debugging-port=9222"`).
  // The value itself may also be quoted (e.g. `--remote-debugging-port="9222"`).
  const m = /(?:^|[\s"])--remote-debugging-port="?(\d+)"?/.exec(cmdline);
  if (!m?.[1]) return null;
  const port = parseInt(m[1], 10);
  return Number.isFinite(port) && port > 0 && port <= 65535 ? port : null;
}
