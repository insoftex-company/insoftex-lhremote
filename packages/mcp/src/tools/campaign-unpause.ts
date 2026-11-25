// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { campaignUnpause } from "@insoftex/lhremote-core";
import { z } from "zod";
import { cdpConnectionSchema, mcpRunCampaignOp } from "../helpers.js";

const campaignId = z.number().int().positive().describe("Campaign ID");

/** Register the {@link https://github.com/insoftex-company/insoftex-lhremote#campaign-unpause | campaign-unpause} MCP tool (Insoftex daily script). */
export function registerCampaignUnpause(server: McpServer): void {
  server.tool(
    "campaign-unpause",
    "Un-pause one campaign WITHOUT starting the account's runner (setCampaignPaused false alone); it runs when the runner next runs. " +
      "Use to restore a campaign paused for a while without waking execution.",
    { campaignId, ...cdpConnectionSchema },
    async ({ campaignId: c, cdpPort, cdpHost, allowRemote, accountId }) =>
      mcpRunCampaignOp("un-pause the campaign", () => campaignUnpause({ campaignId: c, cdpPort, cdpHost, allowRemote, accountId })),
  );
}
