// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type Account,
  LauncherService,
  resolveLauncherPort,
  withLauncherRecovery,
} from "@insoftex/lhremote-core";
import { buildCdpOptions, cdpConnectionSchema, mcpCatchAll, mcpError, mcpSuccess } from "../helpers.js";

/** Register the {@link https://github.com/insoftex-company/insoftex-lhremote#stop-instance | stop-instance} MCP tool. */
export function registerStopInstance(server: McpServer): void {
  server.tool(
    "stop-instance",
    "Stop a running LinkedHelper instance",
    {
      ...cdpConnectionSchema,
    },
    async ({ accountId, cdpPort, cdpHost, allowRemote }) => {
      try {
        const port = await resolveLauncherPort(cdpPort, cdpHost);
        const launcher = new LauncherService(port, buildCdpOptions({ cdpHost, allowRemote }));

        try {
          await launcher.connect();
        } catch (error) {
          return mcpCatchAll(error, "Failed to connect to LinkedHelper");
        }

        try {
          // Phase 1: resolve account ID (auto-select when not provided).
          let resolvedId = accountId;
          let resolveRecovered = false;

          if (resolvedId === undefined) {
            const { result: accounts, launcherRecovered } = await withLauncherRecovery(
              launcher,
              () => launcher.listAccounts(),
            );
            resolveRecovered = launcherRecovered;

            if (accounts.length === 0) {
              return mcpError("No accounts found.");
            }
            if (accounts.length > 1) {
              return mcpError(
                "Multiple accounts found. Specify accountId. Use list-accounts to see available accounts.",
              );
            }
            resolvedId = (accounts[0] as Account).id;
          }

          // Phase 2: stop the instance.
          const { launcherRecovered: stopRecovered } = await withLauncherRecovery(
            launcher,
            async () => { await launcher.stopInstance(resolvedId as number); },
          );
          const launcherRecovered = resolveRecovered || stopRecovered;

          return mcpSuccess(JSON.stringify({
            status: "stopped",
            accountId: resolvedId,
            launcherRecovered,
          }, null, 2));
        } catch (error) {
          return mcpCatchAll(error, "Failed to stop instance");
        } finally {
          launcher.disconnect();
        }
      } catch (error) {
        return mcpCatchAll(error, "Failed to stop instance");
      }
    },
  );
}
