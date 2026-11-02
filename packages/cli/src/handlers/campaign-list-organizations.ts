// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import {
  ActionNotFoundError,
  CampaignNotFoundError,
  errorMessage,
  campaignListOrganizations,
  type CampaignListOrganizationsOutput,
  type CampaignPersonState,
} from "@insoftex/lhremote-core";
import { parseUrls, readUrlsFile } from "../url-list.js";

/** Handle the {@link https://github.com/insoftex-company/insoftex-lhremote#campaigns | campaign-list-organizations} CLI command. */
export async function handleCampaignListOrganizations(
  campaignId: number,
  options: {
    actionId?: number;
    status?: string;
    urls?: string;
    urlsFile?: string;
    limit?: number;
    offset?: number;
    cdpPort?: number;
    cdpHost?: string;
    allowRemote?: boolean;
    accountId?: number;
    json?: boolean;
  },
): Promise<void> {
  if (options.urls && options.urlsFile) {
    process.stderr.write("Use only one of --urls or --urls-file.\n");
    process.exitCode = 1;
    return;
  }

  let companyUrls: string[] | undefined;
  if (options.urls) {
    companyUrls = parseUrls(options.urls);
  } else if (options.urlsFile) {
    try {
      companyUrls = readUrlsFile(options.urlsFile);
    } catch (error) {
      const message = errorMessage(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
      return;
    }
  }

  let result: CampaignListOrganizationsOutput;
  try {
    result = await campaignListOrganizations({
      campaignId,
      actionId: options.actionId,
      status: options.status as CampaignPersonState | undefined,
      companyUrls,
      limit: options.limit,
      offset: options.offset,
      cdpPort: options.cdpPort,
      cdpHost: options.cdpHost,
      allowRemote: options.allowRemote,
      accountId: options.accountId,
    });
  } catch (error) {
    if (error instanceof CampaignNotFoundError) {
      process.stderr.write(`Campaign ${String(campaignId)} not found.\n`);
    } else if (error instanceof ActionNotFoundError) {
      process.stderr.write(
        `Action ${String(options.actionId)} not found in campaign ${String(campaignId)}.\n`,
      );
    } else {
      const message = errorMessage(error);
      process.stderr.write(`${message}\n`);
    }
    process.exitCode = 1;
    return;
  }

  if (options.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(
      `Campaign #${String(campaignId)} Organizations (${String(result.total)} total)\n`,
    );

    if (result.organizations.length === 0) {
      process.stdout.write("  No organizations found.\n");
    } else {
      for (const org of result.organizations) {
        const name = org.name ?? "(unnamed)";
        const identifier = org.publicId ?? org.companyId;
        const suffix = identifier ? ` (${identifier})` : "";
        process.stdout.write(
          `  #${String(org.organizationId)} ${name}${suffix} — ${org.status} at action #${String(org.currentActionId)}\n`,
        );
      }

      if (result.total > result.offset + result.organizations.length) {
        process.stdout.write(
          `\nShowing ${String(result.offset + 1)}-${String(result.offset + result.organizations.length)} of ${String(result.total)}. Use --offset and --limit for pagination.\n`,
        );
      }
    }

    if (result.notFoundCompanyUrls && result.notFoundCompanyUrls.length > 0) {
      process.stdout.write(
        `\n${String(result.notFoundCompanyUrls.length)} of the given URLs are not on the target list:\n`,
      );
      for (const url of result.notFoundCompanyUrls) {
        process.stdout.write(`  ${url}\n`);
      }
    }
  }
}
