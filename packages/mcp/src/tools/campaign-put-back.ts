// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { campaignPutBack } from "@insoftex/lhremote-core";
import { z } from "zod";
import { cdpConnectionSchema, mcpRunCampaignOp } from "../helpers.js";

const campaignId = z.number().int().positive().describe("Campaign ID");
const actionId = z.number().int().positive();
const personIds = z.array(z.number().int().positive()).nonempty().describe("Person IDs");

/** Register the {@link https://github.com/insoftex-company/insoftex-lhremote#campaign-put-back | campaign-put-back} MCP tool (Insoftex daily script). */
export function registerCampaignPutBack(server: McpServer): void {
  server.tool(
    "campaign-put-back",
    "EXPERIMENTAL: put back people dropped at an action by an action-level exclude (result -2): removes that exclude, " +
      "then queues them at the action again. Reads back per person.",
    { campaignId, actionId: actionId.describe("The action they were dropped at"), personIds, ...cdpConnectionSchema },
    async ({ campaignId: c, actionId: a, personIds: p, cdpPort, cdpHost, allowRemote, accountId }) =>
      mcpRunCampaignOp("put people back", () => campaignPutBack({ campaignId: c, actionId: a, personIds: p, cdpPort, cdpHost, allowRemote, accountId })),
  );
}
