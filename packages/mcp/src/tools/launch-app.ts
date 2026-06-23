// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AppLaunchError, AppNotFoundError, AppService } from "@insoftex/lhremote-core";
import { z } from "zod";
import { mcpCatchAll, mcpError, mcpSuccess, wrapProgress } from "../helpers.js";
import { operationRegistry, runAsyncOp } from "../operation-registry.js";

/** Register the {@link https://github.com/insoftex-company/insoftex-lhremote#launch-app | launch-app} MCP tool. */
export function registerLaunchApp(server: McpServer): void {
  server.tool(
    "launch-app",
    "Launch the LinkedHelper application with remote debugging enabled. " +
      "Returns immediately with { status:'in_progress', operationId } if launch takes >2 s. " +
      "Poll get-operation for status. Cancel with cancel-operation.",
    {
      cdpPort: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("CDP port (default: auto-select)"),
      force: z
        .boolean()
        .optional()
        .describe("Kill existing LinkedHelper processes before launching"),
      visible: z
        .boolean()
        .optional()
        .describe("Restore and focus the LinkedHelper launcher window on Windows"),
    },
    async ({ cdpPort, force, visible }, extra) => {
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
          "launch-app",
          async (_signal, registryProgress) => {
            const progress = wrapProgress(registryProgress, extra);
            const app = new AppService(cdpPort, {
              ...(force !== undefined && { force }),
              ...(visible !== undefined && { visible }),
            });

            progress("Launching LinkedHelper");
            try {
              await app.launch();
            } catch (error) {
              if (error instanceof AppNotFoundError || error instanceof AppLaunchError) {
                throw error;
              }
              throw error;
            }

            return `LinkedHelper launched on CDP port ${String(app.cdpPort)}`;
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
                note: "launch-app is running in background. Poll get-operation for status.",
              },
              null,
              2,
            ),
          );
        }

        return mcpSuccess(outcome.result as string);
      } catch (error) {
        if (error instanceof AppNotFoundError || error instanceof AppLaunchError) {
          return mcpError(error.message);
        }
        return mcpCatchAll(error, "Failed to launch LinkedHelper");
      }
    },
  );
}
