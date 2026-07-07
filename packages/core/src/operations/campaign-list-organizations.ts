// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { CampaignOrganizationEntry, CampaignPersonState } from "../types/index.js";
import { resolveAccount } from "../services/account-resolution.js";
import { withDatabase } from "../services/instance-context.js";
import { CampaignRepository } from "../db/index.js";
import { buildCdpOptions, type ConnectionOptions } from "./types.js";
import { extractCompanyId } from "./navigate-to-profile.js";
import { IMPORT_CHUNK_SIZE } from "./import-people-from-urls.js";

/**
 * Input for the campaign-list-organizations operation.
 */
export interface CampaignListOrganizationsInput extends ConnectionOptions {
  readonly campaignId: number;
  readonly actionId?: number | undefined;
  readonly status?: CampaignPersonState | undefined;
  /**
   * Filter (and verify) by LinkedIn company URL. Each URL is resolved to its
   * company identifier (see {@link extractCompanyId}) and matched against the
   * campaign's target list — against both the public slug and the numeric
   * company ID, case-insensitively. Use this to confirm which of a batch of
   * previously-submitted URLs actually landed on the target list — the
   * organizations counterpart of ADR-010's people verification.
   */
  readonly companyUrls?: string[] | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

/**
 * Output from the campaign-list-organizations operation.
 */
export interface CampaignListOrganizationsOutput {
  readonly campaignId: number;
  readonly organizations: CampaignOrganizationEntry[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  /**
   * Present only when {@link CampaignListOrganizationsInput.companyUrls} was
   * given — the subset of those URLs with no corresponding entry in the
   * campaign's target list.
   */
  readonly notFoundCompanyUrls?: string[];
}

/**
 * List organizations assigned to a campaign with optional filtering and
 * pagination. The organizations counterpart of {@link campaignListPeople};
 * shared business logic for the CLI handler and the MCP tool.
 */
export async function campaignListOrganizations(
  input: CampaignListOrganizationsInput,
): Promise<CampaignListOrganizationsOutput> {
  const cdpPort = input.cdpPort;
  const companyUrls = input.companyUrls;

  // Map each URL to its company identifier up front (throws on malformed
  // URLs) so callers get a clear error before any CDP/DB round trip.
  // Keyed by uppercased identifier because the DB match is case-insensitive.
  const urlByCompanyId = new Map<string, string>();
  if (companyUrls !== undefined) {
    for (const url of companyUrls) {
      urlByCompanyId.set(extractCompanyId(url).toUpperCase(), url);
    }
  }
  const companyIds = companyUrls !== undefined ? [...urlByCompanyId.keys()] : undefined;

  // Default limit must cover the whole URL batch when filtering by URL,
  // otherwise pagination could silently hide "found" matches beyond the
  // usual default of 20. Capped at IMPORT_CHUNK_SIZE, the same batch size
  // import-organizations-from-urls uses per CDP call.
  const limit =
    input.limit ?? (companyIds !== undefined ? Math.min(Math.max(companyIds.length, 1), IMPORT_CHUNK_SIZE) : 20);
  const offset = input.offset ?? 0;

  const accountId = await resolveAccount(cdpPort, buildCdpOptions(input));

  return withDatabase(accountId, ({ db }) => {
    const campaignRepo = new CampaignRepository(db);
    const result = campaignRepo.listOrganizations(input.campaignId, {
      ...(input.actionId !== undefined && { actionId: input.actionId }),
      ...(input.status !== undefined && { status: input.status }),
      ...(companyIds !== undefined && { companyIds }),
      limit,
      offset,
    });

    const output: CampaignListOrganizationsOutput = {
      campaignId: input.campaignId,
      organizations: result.organizations,
      total: result.total,
      limit,
      offset,
    };

    if (companyUrls === undefined) {
      return output;
    }

    const foundIds = new Set<string>();
    for (const org of result.organizations) {
      if (org.publicId !== null) foundIds.add(org.publicId.toUpperCase());
      if (org.companyId !== null) foundIds.add(org.companyId.toUpperCase());
    }
    const notFoundCompanyUrls = [...urlByCompanyId.entries()]
      .filter(([companyId]) => !foundIds.has(companyId))
      .map(([, url]) => url);

    return { ...output, notFoundCompanyUrls };
  });
}
