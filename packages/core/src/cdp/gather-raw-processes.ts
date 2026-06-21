// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import psList from "ps-list";

const execFileAsync = promisify(execFile);

/** A raw OS process entry with its command line. */
export interface RawProcess {
  pid: number;
  ppid: number;
  name: string;
  /** Full command line, or null when unavailable. */
  cmdline: string | null;
}

/**
 * Gather all running processes and their command lines.
 *
 * On Windows, `ps-list` does not return the `cmd` field, so we query
 * `Win32_Process` via PowerShell to obtain command lines.  On other
 * platforms the `cmd` field from `ps-list` is used directly.
 *
 * Raw command lines are NEVER exported from process-classification modules
 * — only allowlisted identity fields extracted from them leave those modules.
 */
export async function gatherRawProcesses(): Promise<RawProcess[]> {
  const psProcs = await psList().catch(() => []);

  if (process.platform === "win32") {
    const cmdlineMap = await queryWin32CommandLines();
    return psProcs.map((p) => ({
      pid: p.pid,
      ppid: p.ppid ?? 0,
      name: p.name,
      cmdline: cmdlineMap.get(p.pid) ?? null,
    }));
  }

  return psProcs.map((p) => ({
    pid: p.pid,
    ppid: p.ppid ?? 0,
    name: p.name,
    cmdline: (p as { cmd?: string }).cmd ?? null,
  }));
}

/** Query Win32_Process via PowerShell to get per-PID command lines. */
async function queryWin32CommandLines(): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        // ConvertTo-Json may return a single object (not array) when there is
        // exactly one result, so we wrap in @() to force an array.
        "Get-WmiObject -Query 'SELECT ProcessId,CommandLine FROM Win32_Process' | " +
          "Select-Object ProcessId,CommandLine | " +
          "ConvertTo-Json -Compress",
      ],
      { timeout: 15_000 },
    );

    const raw: unknown = JSON.parse(stdout.trim());
    const rows = Array.isArray(raw) ? raw : [raw];

    for (const row of rows) {
      if (
        row !== null &&
        typeof row === "object" &&
        "ProcessId" in row &&
        "CommandLine" in row
      ) {
        const pid = (row as { ProcessId: number }).ProcessId;
        const cmd = (row as { CommandLine: string | null }).CommandLine;
        if (typeof pid === "number" && typeof cmd === "string" && cmd) {
          map.set(pid, cmd);
        }
      }
    }
  } catch {
    // PowerShell unavailable or query failed; callers handle null cmdlines gracefully.
  }
  return map;
}
