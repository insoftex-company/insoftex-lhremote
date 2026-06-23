// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  acquireLauncherWithRecovery,
  restartInstance,
} from "@insoftex/lhremote-core";
import { buildCdpOptions, cdpConnectionSchema, mcpCatchAll, mcpError, mcpSuccess, wrapProgress } from "../helpers.js";
import { operationRegistry, runAsyncOp } from "../operation-registry.js";

/** Register the restart-instance MCP tool. */
export function registerRestartInstance(server: McpServer): void {
  server.tool(
    "restart-instance",
    "Restart a single LinkedHelper account instance cleanly. " +
      "Stops the running process, waits for it to exit, starts it again, " +
      "and waits until it is connectable on a verified distinct port. " +
      "Idempotent: if the instance is already healthy, returns restarted:false " +
      "without touching it (unless force:true). " +
      "Only the target account's process is affected — other instances keep running. " +
      "Returns immediately with { status:'in_progress', operationId } if the op takes >2 s. " +
      "Poll get-operation for status. Cancel with cancel-operation.",
    {
      ...cdpConnectionSchema,
      force: z
        .boolean()
        .optional()
        .describe(
          "Restart even when the instance is already connectable and healthy. Default: false.",
        ),
    },
    async ({ accountId, cdpPort, cdpHost, allowRemote, force }, extra) => {
      try {
        if (accountId === undefined) {
          return mcpError("accountId is required for restart-instance");
        }

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
          "restart-instance",
          async (signal, registryProgress) => {
            const progress = wrapProgress(registryProgress, extra);

            progress("Acquiring launcher connection");
            const { launcher } = await acquireLauncherWithRecovery(
              cdpPort,
              buildCdpOptions({ cdpHost, allowRemote }),
              { signal },
            );

            try {
              progress(`Restarting instance ${accountId}`);
              const result = await restartInstance(
                launcher,
                accountId,
                launcher.currentPort,
                { force: force ?? false, signal },
              );
              return result;
            } finally {
              launcher.disconnect();
            }
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
                note: "Restart is running in background. Poll get-operation for status. Cancel with cancel-operation.",
              },
              null,
              2,
            ),
          );
        }

        return mcpSuccess(JSON.stringify(outcome.result, null, 2));
      } catch (error) {
        return mcpCatchAll(error, "Failed to restart instance");
      }
    },
  );
}
