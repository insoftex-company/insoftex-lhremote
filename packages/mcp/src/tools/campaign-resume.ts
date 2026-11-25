// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { campaignResume } from "@insoftex/lhremote-core";
import { z } from "zod";
import { cdpConnectionSchema, mcpRunCampaignOp } from "../helpers.js";

const campaignId = z.number().int().positive().describe("Campaign ID");

/** Register the {@link https://github.com/insoftex-company/insoftex-lhremote#campaign-resume | campaign-resume} MCP tool (Insoftex daily script). */
export function registerCampaignResume(server: McpServer): void {
  server.tool(
    "campaign-resume",
    "WAKES EXECUTION: un-pause a campaign and start the account's runner, which runs EVERY active campaign of the account. " +
      "Requires wake: true. Never resets the campaign (unlike campaign-start).",
    { campaignId, wake: z.boolean().describe("Must be true: confirms the account's runner may start"), ...cdpConnectionSchema },
    async ({ campaignId: c, wake, cdpPort, cdpHost, allowRemote, accountId }) =>
      mcpRunCampaignOp("resume the campaign", () => campaignResume({ campaignId: c, wake, cdpPort, cdpHost, allowRemote, accountId })),
  );
}
