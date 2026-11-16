// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hello } from "@insoftex/lhremote-core";
import { mcpCatchAll, mcpSuccess } from "../helpers.js";

/** Register the {@link https://github.com/insoftex-company/insoftex-lhremote#hello | hello} MCP tool. */
export function registerHello(server: McpServer, version = "unknown"): void {
  server.tool(
    "hello",
    "Report which lhremote MCP server is running: its version, the real path of the installed copy " +
      "(symlinks and Windows junctions resolved), Node.js version, platform and process id. " +
      "Needs no LinkedHelper connection — use it to confirm a deploy or an /mcp reconnect took.",
    {},
    () => {
      try {
        return Promise.resolve(mcpSuccess(JSON.stringify(hello(version, import.meta.url), null, 2)));
      } catch (error) {
        return Promise.resolve(mcpCatchAll(error, "Failed to report version"));
      }
    },
  );
}
