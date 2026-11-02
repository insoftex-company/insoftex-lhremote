// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { CampaignPersonEntry, CampaignPersonState } from "../types/index.js";
import { resolveAccount } from "../services/account-resolution.js";
import { withDatabase } from "../services/instance-context.js";
import { CampaignRepository } from "../db/index.js";
import { buildCdpOptions, type ConnectionOptions } from "./types.js";
import { extractPublicId } from "./navigate-to-profile.js";
import { IMPORT_CHUNK_SIZE } from "./import-people-from-urls.js";

/**
 * Input for the campaign-list-people operation.
 */
export interface CampaignListPeopleInput extends ConnectionOptions {
  readonly campaignId: number;
  readonly actionId?: number | undefined;
  readonly status?: CampaignPersonState | undefined;
  /**
   * Filter (and verify) by LinkedIn profile URL. Each URL is resolved to its
   * public ID (see {@link extractPublicId}) and matched against the
   * campaign's target list. Use this to confirm which of a batch of
   * previously-submitted URLs actually landed on the target list — see
   * ADR-010.
   */
  readonly linkedInUrls?: string[] | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

/**
 * Output from the campaign-list-people operation.
 */
export interface CampaignListPeopleOutput {
  readonly campaignId: number;
  readonly people: CampaignPersonEntry[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  /**
   * Present only when {@link CampaignListPeopleInput.linkedInUrls} was
   * given — the subset of those URLs with no corresponding entry in the
   * campaign's target list.
   */
  readonly notFoundLinkedInUrls?: string[];
}

/**
 * List people assigned to a campaign with optional filtering and pagination.
 *
 * This is the shared business logic used by both the CLI handler and
 * the MCP tool.
 */
export async function campaignListPeople(
  input: CampaignListPeopleInput,
): Promise<CampaignListPeopleOutput> {
  const cdpPort = input.cdpPort;
  const linkedInUrls = input.linkedInUrls;

  // Map each URL to its public ID up front (throws on malformed URLs) so
  // callers get a clear error before any CDP/DB round trip.
  const urlByPublicId = new Map<string, string>();
  if (linkedInUrls !== undefined) {
    for (const url of linkedInUrls) {
      urlByPublicId.set(extractPublicId(url), url);
    }
  }
  const publicIds = linkedInUrls !== undefined ? [...urlByPublicId.keys()] : undefined;

  // Default limit must cover the whole URL batch when filtering by URL,
  // otherwise pagination could silently hide "found" matches beyond the
  // usual default of 20. Capped at IMPORT_CHUNK_SIZE, the same batch size
  // import-people-from-urls uses per CDP call.
  const limit =
    input.limit ?? (publicIds !== undefined ? Math.min(Math.max(publicIds.length, 1), IMPORT_CHUNK_SIZE) : 20);
  const offset = input.offset ?? 0;

  const accountId = await resolveAccount(cdpPort, buildCdpOptions(input));

  return withDatabase(accountId, ({ db }) => {
    const campaignRepo = new CampaignRepository(db);
    const result = campaignRepo.listPeople(input.campaignId, {
      ...(input.actionId !== undefined && { actionId: input.actionId }),
      ...(input.status !== undefined && { status: input.status }),
      ...(publicIds !== undefined && { publicIds }),
      limit,
      offset,
    });

    const output: CampaignListPeopleOutput = {
      campaignId: input.campaignId,
      people: result.people,
      total: result.total,
      limit,
      offset,
    };

    if (linkedInUrls === undefined) {
      return output;
    }

    const foundPublicIds = new Set(
      result.people.map((p) => p.publicId).filter((id): id is string => id !== null),
    );
    const notFoundLinkedInUrls = [...urlByPublicId.entries()]
      .filter(([publicId]) => !foundPublicIds.has(publicId))
      .map(([, url]) => url);

    return { ...output, notFoundLinkedInUrls };
  });
}
