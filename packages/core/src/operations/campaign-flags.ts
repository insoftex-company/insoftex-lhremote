// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { resolveAccount } from "../services/account-resolution.js";
import { withInstanceDatabase } from "../services/instance-context.js";
import { CampaignService } from "../services/campaign.js";
import { CampaignRepository } from "../db/index.js";
import { CampaignExecutionError } from "../services/errors.js";
import { buildCdpOptions, type ConnectionOptions } from "./types.js";

/**
 * Campaign-level switches and a person's custom fields, used by the Insoftex daily script (CAMPAIGN_RUNS_LHREMOTE_OPS.md).
 * Each makes one LinkedHelper write call and reads the result back from `lh.db`.
 */

export interface CampaignFlagInput extends ConnectionOptions {
  readonly campaignId: number;
}

export interface CampaignPauseOutput {
  readonly success: true;
  readonly campaignId: number;
  /** `campaigns.is_paused` read back. */
  readonly isPaused: boolean;
}

/**
 * Pause one campaign **alone** (`setCampaignPaused(id, true)`), without stopping the account's runner, unlike
 * `campaign-stop`. Other campaigns of the account keep running. Waiters already running in it still finish when the
 * runner runs (Runtime §13).
 */
export async function campaignPause(input: CampaignFlagInput): Promise<CampaignPauseOutput> {
  const accountId = await resolveAccount(input.cdpPort, buildCdpOptions(input));
  return withInstanceDatabase(input.cdpPort, accountId, async ({ instance, db }) => {
    await new CampaignService(instance, db).pauseCampaign(input.campaignId);
    const isPaused = new CampaignRepository(db).getCampaign(input.campaignId).isPaused;
    if (!isPaused) throw new CampaignExecutionError(`Campaign ${String(input.campaignId)} is not paused after the call`, input.campaignId);
    return { success: true as const, campaignId: input.campaignId, isPaused };
  });
}

export interface CampaignResumeInput extends CampaignFlagInput {
  /**
   * Must be true: resuming starts the account's runner, which runs **every** active campaign of the account (Runtime L9).
   * The caller confirms it knows.
   */
  readonly wake: boolean;
}

export interface CampaignResumeOutput {
  readonly success: true;
  readonly campaignId: number;
  readonly isPaused: boolean;
  /** The account runner's state after the start. */
  readonly runner: unknown;
}

/**
 * Resume a campaign: `setCampaignPaused(id, false)`, then start the account's runner (`campaignController.start()`).
 * Never `resetForRerun` (which `campaign-start` does, L1). **Wakes execution of every active campaign of the account**;
 * refuses unless `wake` is true. Un-pausing does nothing when nobody is queued or in progress.
 */
export async function campaignResume(input: CampaignResumeInput): Promise<CampaignResumeOutput> {
  if (!input.wake) {
    throw new CampaignExecutionError(
      `Resuming campaign ${String(input.campaignId)} starts the account's runner, which runs every active campaign of the account; pass wake to confirm`,
      input.campaignId,
    );
  }
  const accountId = await resolveAccount(input.cdpPort, buildCdpOptions(input));
  return withInstanceDatabase(input.cdpPort, accountId, async ({ instance, db }) => {
    const service = new CampaignService(instance, db);
    await service.unpauseCampaign(input.campaignId);
    await service.startRunner();
    const isPaused = new CampaignRepository(db).getCampaign(input.campaignId).isPaused;
    const runner = await service.getRunnerState();
    return { success: true as const, campaignId: input.campaignId, isPaused, runner };
  });
}

export interface CampaignStandByInput extends CampaignFlagInput {
  readonly on: boolean;
}

export interface CampaignStandByOutput {
  readonly success: true;
  readonly campaignId: number;
  /** `campaigns.is_stand_by_mode_active` read back. */
  readonly standBy: boolean;
  readonly isPaused: boolean;
}

/**
 * Switch a campaign's Stand by mode (`setCampaignStandByModeActive`). **Switching it off on an empty campaign pauses it
 * at once** (Runtime §13).
 */
export async function campaignStandBy(input: CampaignStandByInput): Promise<CampaignStandByOutput> {
  const accountId = await resolveAccount(input.cdpPort, buildCdpOptions(input));
  return withInstanceDatabase(input.cdpPort, accountId, async ({ instance, db }) => {
    await new CampaignService(instance, db).setStandByMode(input.campaignId, input.on);
    const row = db.db
      .prepare("SELECT is_stand_by_mode_active AS standBy, is_paused AS isPaused FROM campaigns WHERE id = ?")
      .get(input.campaignId) as { standBy: number | null; isPaused: number | null } | undefined;
    const standBy = row?.standBy === 1;
    if (standBy !== input.on) {
      throw new CampaignExecutionError(`Campaign ${String(input.campaignId)}: Stand by reads ${String(standBy)} after the call`, input.campaignId);
    }
    return { success: true as const, campaignId: input.campaignId, standBy, isPaused: row?.isPaused === 1 };
  });
}

export interface PersonCustomFieldsInput extends ConnectionOptions {
  readonly personId: number;
  readonly fields: readonly { name: string; content: string }[];
}

export interface PersonCustomFieldsOutput {
  readonly success: true;
  readonly personId: number;
  /** The person's rows in `person_custom_fields` for these names, read back (columns as LinkedHelper stores them). */
  readonly stored: Record<string, unknown>[];
}

/** Parse `name=value` pairs (value may contain "="; empty value clears the field to an empty row). */
export function parseCustomFields(pairs: readonly string[]): { name: string; content: string }[] {
  return pairs.map((pair) => {
    const i = pair.indexOf("=");
    if (i <= 0) throw new Error(`"${pair}" is not name=value`);
    return { name: pair.slice(0, i).trim(), content: pair.slice(i + 1) };
  });
}

/**
 * Save a person's custom fields at CRM level (`savePersonCustomFields`): one write call, nothing else in the evaluate
 * (a save followed by a read in one evaluate hung the instance, Runtime §13). Reads the rows back from `lh.db`.
 */
export async function personCustomFields(input: PersonCustomFieldsInput): Promise<PersonCustomFieldsOutput> {
  if (input.fields.length === 0) throw new Error("No fields to set");
  const accountId = await resolveAccount(input.cdpPort, buildCdpOptions(input));
  return withInstanceDatabase(
    input.cdpPort,
    accountId,
    async ({ instance, db }) => {
      await new CampaignService(instance, db).savePersonCustomFields(input.personId, input.fields);
      const columns = new Set(
        (db.db.prepare("PRAGMA table_info(person_custom_fields)").all() as { name: string }[]).map((c) => c.name),
      );
      if (!columns.has("person_id") || !columns.has("name")) return { success: true as const, personId: input.personId, stored: [] };
      const names = input.fields.map((f) => f.name);
      const stored = db.db
        .prepare(`SELECT * FROM person_custom_fields WHERE person_id = ? AND name IN (${names.map(() => "?").join(", ")})`)
        .all(input.personId, ...names) as Record<string, unknown>[];
      return { success: true as const, personId: input.personId, stored };
    },
  );
}
