// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { campaignIgnoreReply } from "@insoftex/lhremote-core";
import { z } from "zod";
import { cdpConnectionSchema, mcpRunCampaignOp } from "../helpers.js";

const campaignId = z.number().int().positive().describe("Campaign ID");
const actionId = z.number().int().positive();
const personIds = z.array(z.number().int().positive()).nonempty().describe("Person IDs");

/** Register the {@link https://github.com/insoftex-company/insoftex-lhremote#campaign-ignore-reply | campaign-ignore-reply} MCP tool (Insoftex daily script). */
export function registerCampaignIgnoreReply(server: McpServer): void {
  server.tool(
    "campaign-ignore-reply",
    "Ignore the replies of people LinkedHelper holds at an action because they replied (result 2) and move them on " +
      "(Ignore reply and retry). Refuses the last action; reads back per person.",
    { campaignId, actionId: actionId.describe("The action holding them"), personIds, ...cdpConnectionSchema },
    async ({ campaignId: c, actionId: a, personIds: p, cdpPort, cdpHost, allowRemote, accountId }) =>
      mcpRunCampaignOp("ignore replies", () => campaignIgnoreReply({ campaignId: c, actionId: a, personIds: p, cdpPort, cdpHost, allowRemote, accountId })),
  );
}
