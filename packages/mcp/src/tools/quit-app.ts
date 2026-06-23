// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AppService, DEFAULT_CDP_PORT, resolveLauncherPort } from "@insoftex/lhremote-core";
import { z } from "zod";
import { mcpCatchAll, mcpError, mcpSuccess, wrapProgress } from "../helpers.js";
import { operationRegistry, runAsyncOp } from "../operation-registry.js";

/** Register the {@link https://github.com/insoftex-company/insoftex-lhremote#quit-app | quit-app} MCP tool. */
export function registerQuitApp(server: McpServer): void {
  server.tool(
    "quit-app",
    "Quit the LinkedHelper application. " +
      "Returns immediately with { status:'in_progress', operationId } if quit takes >2 s. " +
      "Poll get-operation for status. Cancel with cancel-operation.",
    {
      cdpPort: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("CDP port (auto-discovered from the launcher when omitted)"),
    },
    async ({ cdpPort }, extra) => {
      try {
        // Single-writer check.
        const active = operationRegistry.getActiveWriteOp();
        if (active) {
          return mcpError(
            `Operation ${active.operationId} (${active.kind}) is already running. ` +
              `Cancel it with cancel-operation or poll get-operation for status.`,
          );
        }

        const outcome = await runAsyncOp(
          operationRegistry,
          "quit-app",
          async (_signal, registryProgress) => {
            const progress = wrapProgress(registryProgress, extra);
            progress("Resolving CDP port");
            let port = cdpPort;
            try {
              port ??= await resolveLauncherPort();
            } catch {
              port = DEFAULT_CDP_PORT;
            }

            const app = new AppService(port);
            progress("Quitting LinkedHelper");
            await app.quit();
            return "LinkedHelper quit successfully";
          },
          extra?.signal !== undefined ? { signal: extra.signal } : undefined,
        );

        if (outcome.status === "rejected") {
          return mcpError(outcome.reason);
        }
        if (outcome.status === "in_progress") {
          return mcpSuccess(
            JSON.stringify(
              {
                status: "in_progress",
                operationId: outcome.operationId,
                kind: outcome.kind,
                startedAt: outcome.startedAt,
                note: "quit-app is running in background. Poll get-operation for status.",
              },
              null,
              2,
            ),
          );
        }

        return mcpSuccess(outcome.result as string);
      } catch (error) {
        return mcpCatchAll(error, "Failed to quit LinkedHelper");
      }
    },
  );
}
