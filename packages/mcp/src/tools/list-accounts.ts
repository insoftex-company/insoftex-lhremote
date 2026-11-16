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
    "List available LinkedHelper accounts. By default returns accounts in the currently selected workspace (LinkedHelper 2.113.x+). Pass includeAllWorkspaces=true to enumerate accounts across every workspace the current LH user belongs to. " +
      "Archived accounts (LinkedHelper can't delete accounts, only archive them) are left out unless includeArchived=true; each account carries `archived`.",
    {
      ...cdpConnectionSchema,
      includeAllWorkspaces: z
        .boolean()
        .optional()
        .describe(
          "When true, enumerate accounts across every workspace the user belongs to, not just the selected workspace. Default: false.",
        ),
      includeArchived: z
        .boolean()
        .optional()
        .describe("When true, also return archived accounts. Default: false."),
    },
    async ({ cdpPort, cdpHost, allowRemote, accountId, includeAllWorkspaces, includeArchived }) => {
      try {
        const listOptions = {
          ...(includeAllWorkspaces === true && { includeAllWorkspaces: true }),
          ...(includeArchived === true && { includeArchived: true }),
        };

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
