// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Insoftex

import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve, join } from "node:path";

const require = createRequire(new URL("../packages/mcp/package.json", import.meta.url));
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
assert(process.argv[2], "Usage: node scripts/smoke-package.mjs <deployed-package-directory>");
const stage = resolve(process.argv[2]);
const entrypoint = join(stage, "dist", "cli.js");
// Resolve from the real deployed CLI location: pnpm's virtual store puts its
// dependencies beside it. These packages expose ESM-only entrypoints.
const cliPackage = realpathSync(join(stage, "node_modules", "@insoftex", "lhremote-cli", "package.json"));
const corePackage = createRequire(cliPackage)
  .resolve.paths("@insoftex/lhremote-core")
  .map((directory) => join(directory, "@insoftex", "lhremote-core", "package.json"))
  .find(existsSync);
assert(corePackage, "Deployed CLI must contain its core dependency");
const coreIndex = join(dirname(corePackage), "dist", "index.js");
const { gatherRawProcesses } = await import(
  pathToFileURL(join(dirname(coreIndex), "cdp", "gather-raw-processes.js")).href
);
assert(
  (await gatherRawProcesses()).some((entry) => entry.pid === process.pid),
  "Deployed process-inspection dependency must find this process",
);
const run = (args) =>
  execFileSync(process.execPath, [entrypoint, ...args], { encoding: "utf8", windowsHide: true, timeout: 15000 });
assert.equal(run(["--version"]).trim(), version);
assert(run(["react-to-comment", "--help"]).includes("--account-id"));

const client = new Client({ name: "lhremote-packaging-smoke", version: "1.0.0" });
const transport = new StdioClientTransport({ command: process.execPath, args: [entrypoint, "mcp"], stderr: "pipe" });
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  for (const name of [
    "ensure-instances",
    "restart-instance",
    "react-to-post",
    "campaign-list-organizations",
    "import-organizations-from-urls",
  ]) {
    assert(
      tools.some((tool) => tool.name === name),
      `Missing tool: ${name}`,
    );
  }
  console.log(
    `PASS: deployed CLI version/help and MCP initialization/list-tools (${tools.length} tools). No tools executed.`,
  );
} finally {
  await client.close();
}
