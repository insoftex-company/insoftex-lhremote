// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { resolveAccount } from "../services/account-resolution.js";
import { withInstanceDatabase } from "../services/instance-context.js";
import { CampaignService } from "../services/campaign.js";
import { buildCdpOptions, type ConnectionOptions } from "./types.js";
import { IMPORT_CHUNK_SIZE } from "./import-people-from-urls.js";

export interface ImportOrganizationsFromUrlsInput extends ConnectionOptions {
  readonly campaignId: number;
  readonly companyUrls: string[];
}

export interface ImportOrganizationsFromUrlsOutput {
  readonly success: true;
  readonly campaignId: number;
  readonly actionId: number;
  readonly totalUrls: number;
  readonly imported: number;
  readonly alreadyInQueue: number;
  readonly alreadyProcessed: number;
  readonly inExcludeList: number;
  readonly failed: number;
}

/**
 * Import LinkedIn company URLs into an organizations campaign
 * (`campaigns.type = 2`, e.g. an OrganizationsExtractor chain).
 *
 * The organizations counterpart of {@link importPeopleFromUrls}, chunked
 * with the same {@link IMPORT_CHUNK_SIZE} to avoid CDP payload limits.
 */
export async function importOrganizationsFromUrls(
  input: ImportOrganizationsFromUrlsInput,
): Promise<ImportOrganizationsFromUrlsOutput> {
  const cdpPort = input.cdpPort;

  const accountId = await resolveAccount(cdpPort, buildCdpOptions(input));

  return withInstanceDatabase(cdpPort, accountId, async ({ instance, db }) => {
    const campaignService = new CampaignService(instance, db);

    let actionId = 0;
    let imported = 0;
    let alreadyInQueue = 0;
    let alreadyProcessed = 0;
    let inExcludeList = 0;
    let failed = 0;

    for (let i = 0; i < input.companyUrls.length; i += IMPORT_CHUNK_SIZE) {
      const chunk = input.companyUrls.slice(i, i + IMPORT_CHUNK_SIZE);
      const result = await campaignService.importOrganizationsFromUrls(
        input.campaignId,
        chunk,
      );
      actionId = result.actionId;
      imported += result.successful;
      alreadyInQueue += result.alreadyInQueue;
      alreadyProcessed += result.alreadyProcessed;
      inExcludeList += result.inExcludeList;
      failed += result.failed;
    }

    return {
      success: true as const,
      campaignId: input.campaignId,
      actionId,
      totalUrls: input.companyUrls.length,
      imported,
      alreadyInQueue,
      alreadyProcessed,
      inExcludeList,
      failed,
    };
  });
}
