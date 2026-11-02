// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { scanRunningInstances } from "@insoftex/lhremote-core";
import { z } from "zod";
import { operationRegistry } from "../operation-registry.js";
import { mcpError, mcpSuccess } from "../helpers.js";

/** Register the cancel-operation MCP tool. */
export function registerCancelOperation(server: McpServer): void {
  server.tool(
    "cancel-operation",
    "Cancel a running background operation. " +
      "Signals the operation's AbortController so in-progress waits (port polling, PID exit, launcher recovery) stop promptly. " +
      "Returns the post-cancel state from process inspection. " +
      "WARNING: cancelling a restart-instance mid-flight (after the old instance was stopped but before the new one started) " +
      "may leave the target account instance down — check postCancelInstances in the response and re-run if needed.",
    {
      operationId: z
        .string()
        .describe("The operationId to cancel."),
    },
    async ({ operationId }) => {
      const before = operationRegistry.get(operationId);
      if (!before) {
        return mcpError(`Operation ${operationId} not found. It may have expired (TTL: 10 min) or never existed.`);
      }

      if (before.status !== "running") {
        return mcpSuccess(
          JSON.stringify({
            ...before,
            note: `Operation was already ${before.status} — nothing to cancel.`,
          }, null, 2),
        );
      }

      // Fire the abort signal.
      operationRegistry.cancel(operationId);

      // Give the work a moment to unwind.
      await new Promise<void>((r) => setTimeout(r, 1_500));

      // Post-cancel process inspection — launcher-independent truth.
      const instances = await scanRunningInstances().catch(() => []);

      const after = operationRegistry.get(operationId);
      return mcpSuccess(
        JSON.stringify(
          {
            ...(after ?? before),
            postCancelInstances: instances.map((i) => ({
              accountId: i.accountId,
              pid: i.pid,
              cdpPort: i.cdpPort,
              connectable: i.connectable,
            })),
            note:
              "Operation cancelled. If cancelled mid-restart (after stop, before new start), " +
              "the instance may be down — check postCancelInstances and re-run restart-instance if needed.",
          },
          null,
          2,
        ),
      );
    },
  );
}
