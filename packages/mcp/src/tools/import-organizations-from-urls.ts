// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CampaignExecutionError,
  importOrganizationsFromUrls,
} from "@insoftex/lhremote-core";
import { z } from "zod";
import { cdpConnectionSchema, mcpCatchAll, mcpError, mcpSuccess } from "../helpers.js";

/** Register the {@link https://github.com/insoftex-company/insoftex-lhremote#import-organizations-from-urls | import-organizations-from-urls} MCP tool. */
export function registerImportOrganizationsFromUrls(server: McpServer): void {
  server.tool(
    "import-organizations-from-urls",
    "Import LinkedIn company URLs into an organizations campaign action's target list (campaigns whose targetKind is 'organizations', e.g. an OrganizationsExtractor chain). Rejects people campaigns. Idempotent — re-importing an already-targeted organization is a no-op. Large URL sets are automatically chunked into batches of 200.",
    {
      campaignId: z
        .number()
        .int()
        .positive()
        .describe("Organizations campaign ID to import companies into"),
      companyUrls: z
        .array(z.string().url())
        .nonempty()
        .describe("LinkedIn company URLs to import (e.g. https://www.linkedin.com/company/<slug-or-id>)"),
      ...cdpConnectionSchema,
    },
    async ({ campaignId, companyUrls, cdpPort, cdpHost, allowRemote, accountId }) => {
      try {
        const result = await importOrganizationsFromUrls({ campaignId, companyUrls, cdpPort, cdpHost, allowRemote, accountId });
        return mcpSuccess(JSON.stringify(result, null, 2));
      } catch (error) {
        if (error instanceof CampaignExecutionError) {
          return mcpError(`Failed to import organizations: ${error.message}`);
        }
        return mcpCatchAll(error, "Failed to import organizations");
      }
    },
  );
}
