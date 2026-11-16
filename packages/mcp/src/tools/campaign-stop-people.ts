// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CampaignExecutionError,
  campaignStopPeople,
} from "@insoftex/lhremote-core";
import { z } from "zod";
import { cdpConnectionSchema, mcpCatchAll, mcpError, mcpSuccess } from "../helpers.js";

/** Register the {@link https://github.com/insoftex-company/insoftex-lhremote#campaign-stop-people | campaign-stop-people} MCP tool. */
export function registerCampaignStopPeople(server: McpServer): void {
  server.tool(
    "campaign-stop-people",
    "Stop people wherever they are in a campaign's sequence, so no further action runs for them. " +
      "For each person still in progress: adds an action-level exclude on every action after the one they are on, " +
      "then removes them from their current action (live instance). Reads the database back and reports per person " +
      "whether both took (outcome stopped / finished / alreadyStopped / notInCampaign). " +
      "Use this instead of campaign-remove-people, which only removes from the first action. " +
      "Never re-import a stopped person into the same campaign or pass their id to campaign-start: " +
      "campaign-start with personIds re-queues them at every action.",
    {
      campaignId: z
        .number()
        .int()
        .positive()
        .describe("Campaign ID to stop people in"),
      personIds: z
        .array(z.number().int().positive())
        .nonempty()
        .describe("Person IDs to stop"),
      ...cdpConnectionSchema,
    },
    async ({ campaignId, personIds, cdpPort, cdpHost, allowRemote, accountId }) => {
      try {
        const result = await campaignStopPeople({ campaignId, personIds, cdpPort, cdpHost, allowRemote, accountId });
        return mcpSuccess(JSON.stringify(result, null, 2));
      } catch (error) {
        if (error instanceof CampaignExecutionError) {
          return mcpError(`Failed to stop people: ${error.message}`);
        }
        return mcpCatchAll(error, "Failed to stop people");
      }
    },
  );
}
