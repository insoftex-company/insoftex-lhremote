// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { campaignMoveOn } from "@insoftex/lhremote-core";
import { z } from "zod";
import { cdpConnectionSchema, mcpRunCampaignOp } from "../helpers.js";

const campaignId = z.number().int().positive().describe("Campaign ID");
const actionId = z.number().int().positive();
const personIds = z.array(z.number().int().positive()).nonempty().describe("Person IDs");

/** Register the {@link https://github.com/insoftex-company/insoftex-lhremote#campaign-move-on | campaign-move-on} MCP tool (Insoftex daily script). */
export function registerCampaignMoveOn(server: McpServer): void {
  server.tool(
    "campaign-move-on",
    "Move people whose step failed at an action (result -1) on to the next action (LinkedHelper's move to next action). " +
      "Checks each person's result first; refuses the last action; reads the move back per person (done / notDone / skipped).",
    { campaignId, actionId: actionId.describe("The action where their step failed"), personIds, ...cdpConnectionSchema },
    async ({ campaignId: c, actionId: a, personIds: p, cdpPort, cdpHost, allowRemote, accountId }) =>
      mcpRunCampaignOp("move people on", () => campaignMoveOn({ campaignId: c, actionId: a, personIds: p, cdpPort, cdpHost, allowRemote, accountId })),
  );
}
