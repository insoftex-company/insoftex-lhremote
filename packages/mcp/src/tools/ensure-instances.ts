// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { acquireLauncherWithRecovery, ensureInstances, withLauncherCDPGate } from "@insoftex/lhremote-core";
import { z } from "zod";
import { buildCdpOptions, cdpConnectionSchema, mcpCatchAll, mcpError, mcpSuccess, wrapProgress } from "../helpers.js";
import { operationRegistry, runAsyncOp } from "../operation-registry.js";

/** Register the ensure-instances MCP tool. */
export function registerEnsureInstances(server: McpServer): void {
  server.tool(
    "ensure-instances",
    "Idempotently bring up the specified set of LinkedHelper account instances. " +
      "Skips accounts that already have a verified-running instance; starts the rest one at a time with verification between each. " +
      "Returns a per-account result table, or { status:'in_progress', operationId } if the operation takes >2 s. " +
      "Poll get-operation for status. Cancel with cancel-operation.",
    {
      accountIds: z
        .array(z.number().int().positive())
        .min(1)
        .describe("List of account IDs that should be running."),
      ...cdpConnectionSchema,
    },
    async ({ accountIds, cdpPort, cdpHost, allowRemote }, extra) => {
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
          "ensure-instances",
          async (signal, registryProgress) => {
            const progress = wrapProgress(registryProgress, extra);

            progress("Acquiring launcher connection");
            return await withLauncherCDPGate(async () => {
              const { launcher } = await acquireLauncherWithRecovery(
                cdpPort,
                buildCdpOptions({ cdpHost, allowRemote }),
                { signal },
              );
              try {
                progress(`Starting ${accountIds.length} instance(s)`);
                return await ensureInstances(accountIds, launcher, launcher.currentPort);
              } finally {
                launcher.disconnect();
              }
            });
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
                note: "ensure-instances is running in background. Poll get-operation for status. Cancel with cancel-operation.",
              },
              null,
              2,
            ),
          );
        }

        return mcpSuccess(JSON.stringify(outcome.result, null, 2));
      } catch (error) {
        return mcpCatchAll(error, "Failed to ensure instances");
      }
    },
  );
}
