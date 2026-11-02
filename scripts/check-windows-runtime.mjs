// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Insoftex

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { gatherRawProcesses, invalidateProcessCache } from "../packages/core/dist/cdp/gather-raw-processes.js";
import { listListeningTcpPorts } from "../packages/core/dist/cdp/list-listening-ports.js";

if (process.platform !== "win32") {
  console.log("SKIPPED: native Windows runtime checks require Windows.");
  process.exit(0);
}

const execFileAsync = promisify(execFile);
const bootstrap = fileURLToPath(new URL("./launch-linkedhelper.ps1", import.meta.url));
await execFileAsync(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `
  $tokens = $null; $parseErrors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($env:LHREMOTE_BOOTSTRAP_PATH, [ref]$tokens, [ref]$parseErrors) | Out-Null
  if ($parseErrors.Count) { $parseErrors | ForEach-Object { Write-Error $_.Message }; exit 1 }
`,
  ],
  { env: { ...process.env, LHREMOTE_BOOTSTRAP_PATH: bootstrap }, windowsHide: true, timeout: 15000 },
);
console.log("PASS: bootstrap parses in Windows PowerShell 5.1; bootstrap was not executed.");

const marker = "lhremote-native-Привіт-🇺🇦";
const child = spawn(process.execPath, ["--eval", "setTimeout(() => {}, 30000)", "--", marker], {
  stdio: "ignore",
  windowsHide: true,
});
const server = createServer();
try {
  await once(child, "spawn");
  const deadline = Date.now() + 10000;
  let captured = false;
  do {
    invalidateProcessCache();
    const processes = await gatherRawProcesses();
    captured = processes.some((entry) => entry.pid === child.pid && entry.cmdline?.includes(marker));
    if (!captured) await new Promise((resolve) => setTimeout(resolve, 250));
  } while (!captured && Date.now() < deadline);
  assert(captured, "Windows process inspection must preserve the Unicode command line of our own child");
  console.log("PASS: native CIM/ps-list inspection preserves UTF-8 account-like arguments.");

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const ports = await listListeningTcpPorts(process.pid);
  assert(ports.includes(address.port), "Native Windows netstat must find our own listening socket");
  console.log("PASS: native netstat listener/PID discovery.");
} finally {
  server.close();
  child.kill();
}

console.log("Native Windows smoke passed. No LinkedHelper processes or accounts were modified.");
