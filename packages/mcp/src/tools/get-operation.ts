// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { operationRegistry } from "../operation-registry.js";
import { mcpError, mcpSuccess } from "../helpers.js";

/** Register the get-operation MCP tool. */
export function registerGetOperation(server: McpServer): void {
  server.tool(
    "get-operation",
    "Poll the status of a background launcher operation (start/stop/restart-instance, ensure-instances, launch-app, quit-app). " +
      "Returns current status, accumulated progress messages, and the final result or error when done. " +
      "Safe to call repeatedly; launcher-independent (no CDP required).",
    {
      operationId: z
        .string()
        .describe("The operationId returned by the original tool call."),
    },
    ({ operationId }) => {
      const record = operationRegistry.get(operationId);
      if (!record) {
        return mcpError(`Operation ${operationId} not found. It may have expired (TTL: 10 min) or never existed.`);
      }
      return mcpSuccess(JSON.stringify(record, null, 2));
    },
  );
}
