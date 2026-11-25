// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { campaignPause } from "@insoftex/lhremote-core";
import { z } from "zod";
import { cdpConnectionSchema, mcpRunCampaignOp } from "../helpers.js";

const campaignId = z.number().int().positive().describe("Campaign ID");

/** Register the {@link https://github.com/insoftex-company/insoftex-lhremote#campaign-pause | campaign-pause} MCP tool (Insoftex daily script). */
export function registerCampaignPause(server: McpServer): void {
  server.tool(
    "campaign-pause",
    "Pause one campaign alone (setCampaignPaused), without stopping the account's runner; other campaigns keep running. " +
      "Waiters already running in it still finish when the runner runs.",
    { campaignId, ...cdpConnectionSchema },
    async ({ campaignId: c, cdpPort, cdpHost, allowRemote, accountId }) =>
      mcpRunCampaignOp("pause the campaign", () => campaignPause({ campaignId: c, cdpPort, cdpHost, allowRemote, accountId })),
  );
}
