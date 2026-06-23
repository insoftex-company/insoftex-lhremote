// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type Account,
  acquireLauncherWithRecovery,
  startInstanceWithRecovery,
  waitForConnectable,
  withLauncherQueue,
  withLauncherRecovery,
} from "@insoftex/lhremote-core";
import { buildCdpOptions, cdpConnectionSchema, mcpCatchAll, mcpError, mcpSuccess, wrapProgress } from "../helpers.js";
import { operationRegistry, runAsyncOp } from "../operation-registry.js";

/** Register the {@link https://github.com/insoftex-company/insoftex-lhremote#start-instance | start-instance} MCP tool. */
export function registerStartInstance(server: McpServer): void {
  server.tool(
    "start-instance",
    "Start a LinkedHelper instance for a LinkedIn account. Required before campaign or query operations. " +
      "Returns immediately with { status:'in_progress', operationId } if the instance takes >2 s to start. " +
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
          "start-instance",
          async (signal, registryProgress) => {
            const progress = wrapProgress(registryProgress, extra);

            progress("Acquiring launcher connection");
            const { launcher } = await acquireLauncherWithRecovery(
              cdpPort,
              buildCdpOptions({ cdpHost, allowRemote }),
              { signal },
            );

            try {
              // Phase 1: resolve account ID.
              let resolvedId = accountId;

              if (resolvedId === undefined) {
                const { result: accounts } = await withLauncherRecovery(
                  launcher,
                  () => launcher.listAccounts(),
                  { signal },
                );

                if (accounts.length === 0) {
                  throw new Error("No accounts found.");
                }
                if (accounts.length > 1) {
                  throw new Error(
                    "Multiple accounts found. Specify accountId. Use list-accounts to see available accounts.",
                  );
                }
                resolvedId = (accounts[0] as Account).id;
              }

              // Phase 2: start through the launcher queue.
              progress(`Starting instance ${resolvedId}`);
              const port = launcher.currentPort;
              const { result: opOutcome } = await withLauncherQueue(
                () =>
                  withLauncherRecovery(
                    launcher,
                    () => startInstanceWithRecovery(launcher, resolvedId as number, launcher.currentPort),
                    { signal },
                  ),
                { type: "start", accountId: resolvedId as number, launcherPort: port },
              );

              if (opOutcome.status === "timeout") {
                const waitResult = await waitForConnectable(resolvedId as number, { signal });
                if (waitResult.verified && waitResult.cdpPort !== null) {
                  return {
                    text:
                      `Instance started for account ${resolvedId} on CDP port ${waitResult.cdpPort}` +
                      (waitResult.pid !== undefined ? ` — PID ${waitResult.pid}` : "") +
                      " — verified (process inspection)",
                    type: "text" as const,
                  };
                }
                throw new Error("Instance started but failed to initialize within timeout.");
              }

              const verb = opOutcome.status === "already_running" ? "already running" : "started";
              let text = `Instance ${verb} for account ${resolvedId} on CDP port ${opOutcome.port}`;
              if (opOutcome.pid !== undefined) text += ` — PID ${opOutcome.pid}`;
              if (opOutcome.verified === true) text += " — verified";
              else if (opOutcome.verified === false) text += " — NOT verified — duplicate port suspected";
              return { text, type: "text" as const };
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
                note: "start-instance is running in background. Poll get-operation for status.",
              },
              null,
              2,
            ),
          );
        }

        // result is { text, type } from the work function
        const res = outcome.result as { text: string; type: string };
        return mcpSuccess(res.text);
      } catch (error) {
        return mcpCatchAll(error, "Failed to start instance");
      }
    },
  );
}
