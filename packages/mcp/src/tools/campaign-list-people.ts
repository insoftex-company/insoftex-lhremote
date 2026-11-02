// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ActionNotFoundError,
  campaignListPeople,
} from "@insoftex/lhremote-core";
import { z } from "zod";
import { cdpConnectionSchema, mcpCatchAll, mcpError, mcpSuccess } from "../helpers.js";

/** Register the {@link https://github.com/insoftex-company/insoftex-lhremote#campaign-list-people | campaign-list-people} MCP tool. */
export function registerCampaignListPeople(server: McpServer): void {
  server.tool(
    "campaign-list-people",
    "List people assigned to a campaign with their processing status. Returns person details (name, LinkedIn public ID) and which action they are currently at.",
    {
      campaignId: z
        .number()
        .int()
        .positive()
        .describe("Campaign ID"),
      actionId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Filter to people in a specific action"),
      status: z
        .enum(["queued", "processed", "successful", "failed"])
        .optional()
        .describe("Filter by processing status"),
      linkedInUrls: z
        .array(z.string())
        .optional()
        .describe(
          "Filter to (and verify) these LinkedIn profile URLs. Use this after a bulk " +
            "import-people-from-urls call to confirm, per URL, which contacts actually landed " +
            "on the target list — see notFoundLinkedInUrls in the response for the rest.",
        ),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of results (default: 20, or the number of linkedInUrls when filtering by URL)"),
      offset: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(0)
        .describe("Pagination offset (default: 0)"),
      ...cdpConnectionSchema,
    },
    async ({ campaignId, actionId, status, linkedInUrls, limit, offset, cdpPort, cdpHost, allowRemote, accountId }) => {
      try {
        const result = await campaignListPeople({ campaignId, actionId, status, linkedInUrls, limit, offset, cdpPort, cdpHost, allowRemote, accountId });
        return mcpSuccess(JSON.stringify(result, null, 2));
      } catch (error) {
        if (error instanceof ActionNotFoundError) {
          return mcpError(`Action ${String(actionId)} not found in campaign ${String(campaignId)}.`);
        }
        return mcpCatchAll(error, "Failed to list campaign people");
      }
    },
  );
}
