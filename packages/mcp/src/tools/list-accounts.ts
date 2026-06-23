// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  acquireLauncherWithRecovery,
  withLauncherCDPGate,
  withLauncherRecovery,
} from "@insoftex/lhremote-core";
import { z } from "zod";
import { buildCdpOptions, cdpConnectionSchema, mcpCatchAll, mcpSuccess } from "../helpers.js";

/** Register the {@link https://github.com/insoftex-company/insoftex-lhremote#list-accounts | list-accounts} MCP tool. */
export function registerListAccounts(server: McpServer): void {
  server.tool(
    "list-accounts",
    "List available LinkedHelper accounts. By default returns accounts in the currently selected workspace (LinkedHelper 2.113.x+). Pass includeAllWorkspaces=true to enumerate accounts across every workspace the current LH user belongs to.",
    {
      ...cdpConnectionSchema,
      includeAllWorkspaces: z
        .boolean()
        .optional()
        .describe(
          "When true, enumerate accounts across every workspace the user belongs to, not just the selected workspace. Default: false.",
        ),
    },
    async ({ cdpPort, cdpHost, allowRemote, accountId, includeAllWorkspaces }) => {
      try {
        const listOptions = includeAllWorkspaces === true
          ? { includeAllWorkspaces: true }
          : undefined;

        const accounts = await withLauncherCDPGate(async () => {
          const { launcher } = await acquireLauncherWithRecovery(
            cdpPort,
            buildCdpOptions({ cdpHost, allowRemote, accountId }),
          );
          try {
            const { result } = await withLauncherRecovery(
              launcher,
              () => launcher.listAccounts(listOptions),
            );
            return result;
          } finally {
            launcher.disconnect();
          }
        });

        return mcpSuccess(JSON.stringify(accounts, null, 2));
      } catch (error) {
        return mcpCatchAll(error, "Failed to list accounts");
      }
    },
  );
}
