// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { personCustomFields } from "@insoftex/lhremote-core";
import { z } from "zod";
import { cdpConnectionSchema, mcpRunCampaignOp } from "../helpers.js";



/** Register the {@link https://github.com/insoftex-company/insoftex-lhremote#person-custom-fields | person-custom-fields} MCP tool (Insoftex daily script). */
export function registerPersonCustomFields(server: McpServer): void {
  server.tool(
    "person-custom-fields",
    "Save a person's custom fields (CRM level); an empty content clears the field. Reads the stored rows back.",
    {
      personId: z.number().int().positive().describe("Person ID"),
      fields: z.array(z.object({ name: z.string().min(1), content: z.string() })).nonempty().describe("Fields to set"),
      ...cdpConnectionSchema,
    },
    async ({ personId, fields, cdpPort, cdpHost, allowRemote, accountId }) =>
      mcpRunCampaignOp("save custom fields", () => personCustomFields({ personId, fields, cdpPort, cdpHost, allowRemote, accountId })),
  );
}
