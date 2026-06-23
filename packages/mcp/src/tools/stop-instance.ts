// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type Account,
  acquireLauncherWithRecovery,
  waitForInstanceShutdown,
  withLauncherCDPGate,
  withLauncherQueue,
  withLauncherRecovery,
} from "@insoftex/lhremote-core";
import { buildCdpOptions, cdpConnectionSchema, mcpCatchAll, mcpError, mcpSuccess, wrapProgress } from "../helpers.js";
import { operationRegistry, runAsyncOp } from "../operation-registry.js";

/** Register the {@link https://github.com/insoftex-company/insoftex-lhremote#stop-instance | stop-instance} MCP tool. */
export function registerStopInstance(server: McpServer): void {
  server.tool(
    "stop-instance",
    "Stop a running LinkedHelper instance. " +
      "Returns immediately with { status:'in_progress', operationId } if the op takes >2 s. " +
      "Poll get-operation for status. Cancel with cancel-operation.",
    {
      ...cdpConnectionSchema,
    },
    async ({ accountId, cdpPort, cdpHost, allowRemote }, extra) => {
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
          "stop-instance",
          async (signal, registryProgress) => {
            const progress = wrapProgress(registryProgress, extra);

            progress("Acquiring launcher connection");

            // Resolve account ID if not supplied (gate window kept short).
            let resolvedId = accountId;
            if (resolvedId === undefined) {
              resolvedId = await withLauncherCDPGate(async () => {
                const { launcher } = await acquireLauncherWithRecovery(
                  cdpPort,
                  buildCdpOptions({ cdpHost, allowRemote }),
                  { signal },
                );
                try {
                  const { result: accounts } = await withLauncherRecovery(
                    launcher,
                    () => launcher.listAccounts(),
                    { signal },
                  );
                  if (accounts.length === 0) throw new Error("No accounts found.");
                  if (accounts.length > 1) {
                    throw new Error(
                      "Multiple accounts found. Specify accountId. Use list-accounts to see available accounts.",
                    );
                  }
                  return (accounts[0] as Account).id;
                } finally {
                  launcher.disconnect();
                }
              });
            }

            progress(`Stopping instance ${resolvedId}`);
            await withLauncherQueue(
              () =>
                withLauncherCDPGate(async () => {
                  const { launcher } = await acquireLauncherWithRecovery(
                    cdpPort,
                    buildCdpOptions({ cdpHost, allowRemote }),
                    { signal },
                  );
                  const port = launcher.currentPort;
                  try {
                    await withLauncherRecovery(
                      launcher,
                      async () => {
                        await launcher.stopInstance(resolvedId as number);
                        await waitForInstanceShutdown(port);
                      },
                      { signal },
                    );
                  } finally {
                    launcher.disconnect();
                  }
                }),
              { type: "stop" },
            );

            return `Instance stopped for account ${resolvedId}`;
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
                note: "stop-instance is running in background. Poll get-operation for status.",
              },
              null,
              2,
            ),
          );
        }

        return mcpSuccess(outcome.result as string);
      } catch (error) {
        return mcpCatchAll(error, "Failed to stop instance");
      }
    },
  );
}
