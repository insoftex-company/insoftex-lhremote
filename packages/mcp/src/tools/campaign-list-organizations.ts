// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ActionNotFoundError,
  campaignListOrganizations,
} from "@insoftex/lhremote-core";
import { z } from "zod";
import { cdpConnectionSchema, mcpCatchAll, mcpError, mcpSuccess } from "../helpers.js";

/** Register the {@link https://github.com/insoftex-company/insoftex-lhremote#campaign-list-organizations | campaign-list-organizations} MCP tool. */
export function registerCampaignListOrganizations(server: McpServer): void {
  server.tool(
    "campaign-list-organizations",
    "List organizations assigned to an organizations campaign with their processing status. Returns organization details (name, LinkedIn slug, numeric company ID) and which action they are currently at.",
    {
      campaignId: z
        .number()
        .int()
        .positive()
        .describe("Campaign ID (must be an organizations campaign)"),
      actionId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Filter to organizations in a specific action"),
      status: z
        .enum(["queued", "processed", "successful", "failed"])
        .optional()
        .describe("Filter by processing status"),
      companyUrls: z
        .array(z.string())
        .optional()
        .describe(
          "Filter to (and verify) these LinkedIn company URLs. Use this after a bulk " +
            "import-organizations-from-urls call to confirm, per URL, which companies actually " +
            "landed on the target list — see notFoundCompanyUrls in the response for the rest.",
        ),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of results (default: 20, or the number of companyUrls when filtering by URL)"),
      offset: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(0)
        .describe("Pagination offset (default: 0)"),
      ...cdpConnectionSchema,
    },
    async ({ campaignId, actionId, status, companyUrls, limit, offset, cdpPort, cdpHost, allowRemote, accountId }) => {
      try {
        const result = await campaignListOrganizations({ campaignId, actionId, status, companyUrls, limit, offset, cdpPort, cdpHost, allowRemote, accountId });
        return mcpSuccess(JSON.stringify(result, null, 2));
      } catch (error) {
        if (error instanceof ActionNotFoundError) {
          return mcpError(`Action ${String(actionId)} not found in campaign ${String(campaignId)}.`);
        }
        return mcpCatchAll(error, "Failed to list campaign organizations");
      }
    },
  );
}
