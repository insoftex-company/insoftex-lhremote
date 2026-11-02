// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { Profile } from "../types/index.js";
import { resolveAccount } from "../services/account-resolution.js";
import { withInstanceDatabase } from "../services/instance-context.js";
import { ProfileRepository } from "../db/index.js";
import { EphemeralCampaignService } from "../services/ephemeral-campaign.js";
import { CampaignExecutionError } from "../services/errors.js";
import { buildCdpOptions } from "./types.js";
import { type EphemeralActionInput } from "./ephemeral-action.js";
import { waitForLoggedInState } from "./wait-for-logged-in-state.js";

export interface VisitProfileInput extends EphemeralActionInput {
  readonly extractCurrentOrganizations?: boolean | undefined;
}

export interface VisitProfileOutput {
  readonly success: true;
  readonly actionType: "VisitAndExtract";
  readonly profile: Profile;
}

export async function visitProfile(
  input: VisitProfileInput,
): Promise<VisitProfileOutput> {
  if ((input.personId == null) === (input.url == null)) {
    throw new Error("Exactly one of personId or url must be provided");
  }

  const cdpPort = input.cdpPort;

  const accountId = await resolveAccount(cdpPort, buildCdpOptions(input));

  return withInstanceDatabase(cdpPort, accountId, async ({ instance, db }) => {
    const repo = new ProfileRepository(db);

    await waitForLoggedInState(instance, { timeout: 60_000 });

    const target: number | string = input.personId ?? (input.url as string);
    const actionSettings = input.extractCurrentOrganizations !== undefined
      ? { extractCurrentOrganizations: input.extractCurrentOrganizations }
      : undefined;

    const ephemeral = new EphemeralCampaignService(instance, db);
    const result = await ephemeral.execute("VisitAndExtract", target, actionSettings, {
      ...(input.keepCampaign !== undefined && { keepCampaign: input.keepCampaign }),
      ...(input.timeout !== undefined && { timeout: input.timeout }),
    });

    if (!result.success) {
      throw new CampaignExecutionError(
        `VisitAndExtract action did not complete successfully for person ${String(result.personId)}`,
        result.campaignId,
      );
    }

    const profile = repo.findById(result.personId, { includePositions: true });

    return {
      success: true as const,
      actionType: "VisitAndExtract" as const,
      profile,
    };
  }, { instanceTimeout: 120_000, db: { readOnly: false } });
}
