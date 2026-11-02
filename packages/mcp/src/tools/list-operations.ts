// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { operationRegistry } from "../operation-registry.js";
import { mcpSuccess } from "../helpers.js";

/** Register the list-operations MCP tool. */
export function registerListOperations(server: McpServer): void {
  server.tool(
    "list-operations",
    "List recent and active background operations (start/stop/restart-instance, ensure-instances, launch-app, quit-app). " +
      "Running operations appear first. Completed entries are retained for 10 minutes then pruned. " +
      "Launcher-independent — no CDP required.",
    {},
    () => {
      const ops = operationRegistry.list();
      // Running first, then by startedAt descending.
      ops.sort((a, b) => {
        if (a.status === "running" && b.status !== "running") return -1;
        if (a.status !== "running" && b.status === "running") return 1;
        return b.startedAt.localeCompare(a.startedAt);
      });
      return mcpSuccess(JSON.stringify(ops, null, 2));
    },
  );
}
