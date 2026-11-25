// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { campaignStandBy } from "@insoftex/lhremote-core";
import { z } from "zod";
import { cdpConnectionSchema, mcpRunCampaignOp } from "../helpers.js";

const campaignId = z.number().int().positive().describe("Campaign ID");

/** Register the {@link https://github.com/insoftex-company/insoftex-lhremote#campaign-stand-by | campaign-stand-by} MCP tool (Insoftex daily script). */
export function registerCampaignStandBy(server: McpServer): void {
  server.tool(
    "campaign-stand-by",
    "Switch a campaign's Stand by mode. Switching it off on an empty campaign pauses it at once.",
    { campaignId, on: z.boolean().describe("true = Stand by on, false = off"), ...cdpConnectionSchema },
    async ({ campaignId: c, on, cdpPort, cdpHost, allowRemote, accountId }) =>
      mcpRunCampaignOp("switch Stand by", () => campaignStandBy({ campaignId: c, on, cdpPort, cdpHost, allowRemote, accountId })),
  );
}
