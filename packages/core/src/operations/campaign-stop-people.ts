// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { resolveAccount } from "../services/account-resolution.js";
import { withInstanceDatabase } from "../services/instance-context.js";
import { CampaignService } from "../services/campaign.js";
import {
  CampaignExcludeListRepository,
  CampaignRepository,
  type PersonCampaignProgress,
} from "../db/index.js";
import { CampaignExecutionError } from "../services/errors.js";
import { buildCdpOptions, type ConnectionOptions } from "./types.js";

/** `action_target_people.state` for a removed person (tombstone). */
const REMOVED_STATE = -1;

export interface CampaignStopPeopleInput extends ConnectionOptions {
  readonly campaignId: number;
  readonly personIds: number[];
}

/**
 * What happened to one person:
 * - `stopped`: excluded on every later action and removed from the current one;
 * - `finished`: already has a result for the campaign's last action, nothing to stop;
 * - `alreadyStopped`: every latest row is a removal, nothing left to stop;
 * - `notInCampaign`: no target-list rows in this campaign.
 */
export type PersonStopOutcome =
  | "stopped"
  | "finished"
  | "alreadyStopped"
  | "notInCampaign";

export interface PersonStopResult {
  readonly personId: number;
  readonly outcome: PersonStopOutcome;
  /** The action the person was on when stopped (only for `stopped`). */
  readonly currentActionId?: number;
  /** Actions the person was excluded on (only for `stopped`). */
  readonly excludedActionIds?: number[];
  /** Read back after the stop (only for `stopped`). */
  readonly verified?: {
    /** Latest row at the current action is a removal. */
    readonly removedFromCurrentAction: boolean;
    /** The person is on the exclude list of every later action. */
    readonly excludedOnLaterActions: boolean;
  };
}

export interface CampaignStopPeopleOutput {
  readonly success: true;
  readonly campaignId: number;
  readonly stopped: number;
  readonly people: PersonStopResult[];
}

/** A stop plan for one person, derived from their campaign progress. */
export interface PersonStopPlan {
  readonly outcome: PersonStopOutcome;
  readonly currentActionId?: number;
  readonly laterActionIds?: number[];
}

/**
 * Decide how to stop one person.
 *
 * The current action is the furthest action (in campaign order) whose latest
 * row is not a removal and that has no result yet. Rationale and evidence
 * (Insoftex WP0 T0.5, LinkedHelper 2.140.4): removal from the current action
 * stops the person there; an action-level exclude on a later action drops the
 * person when they arrive (result -2); a removal on an action not yet reached
 * writes nothing; campaign-level excludes don't stop a running person.
 *
 * @param actionIds - The campaign's action ids in execution order.
 */
export function planPersonStop(
  actionIds: readonly number[],
  progress: PersonCampaignProgress | undefined,
): PersonStopPlan {
  if (progress === undefined || progress.latestStateByAction.size === 0) {
    return { outcome: "notInCampaign" };
  }

  const lastActionId = actionIds[actionIds.length - 1];
  if (lastActionId !== undefined && progress.resultByAction.has(lastActionId)) {
    return { outcome: "finished" };
  }

  for (let i = actionIds.length - 1; i >= 0; i--) {
    const actionId = actionIds[i] as number;
    const state = progress.latestStateByAction.get(actionId);
    if (state === undefined || state === REMOVED_STATE) continue;
    if (progress.resultByAction.has(actionId)) continue;
    return {
      outcome: "stopped",
      currentActionId: actionId,
      laterActionIds: actionIds.slice(i + 1),
    };
  }

  return { outcome: "alreadyStopped" };
}

/**
 * Stop people in a campaign, wherever they are in its sequence.
 *
 * For each person still in progress:
 * 1. action-level exclude on **every action after** the one they are on
 *    (written first, so a person who advances during the call is still
 *    dropped at the next action);
 * 2. removal from the action they are **currently** on, via a live instance.
 *
 * Then reads the database back and reports, per person, whether both took.
 * Never re-import a stopped person into the same campaign: LinkedHelper then
 * undoes the removal and replays the remaining steps at once.
 *
 * @throws {CampaignNotFoundError} if the campaign does not exist.
 * @throws {CampaignExecutionError} if the campaign has no actions or the CDP call fails.
 */
export async function campaignStopPeople(
  input: CampaignStopPeopleInput,
): Promise<CampaignStopPeopleOutput> {
  const cdpPort = input.cdpPort;

  const accountId = await resolveAccount(cdpPort, buildCdpOptions(input));

  return withInstanceDatabase(
    cdpPort,
    accountId,
    async ({ instance, db }) => {
      const campaignRepo = new CampaignRepository(db);
      const excludeRepo = new CampaignExcludeListRepository(db);
      const campaignService = new CampaignService(instance, db);

      const actionIds = campaignRepo
        .getCampaignActions(input.campaignId)
        .map((a) => a.id);
      if (actionIds.length === 0) {
        throw new CampaignExecutionError(
          `Campaign ${String(input.campaignId)} has no actions`,
          input.campaignId,
        );
      }

      const personIds = [...new Set(input.personIds)];
      const before = campaignRepo.getPeopleProgress(input.campaignId, personIds);
      const plans = new Map(
        personIds.map((id) => [id, planPersonStop(actionIds, before.get(id))]),
      );

      // 1. Exclude on every later action first.
      for (const [personId, plan] of plans) {
        if (plan.outcome !== "stopped") continue;
        for (const actionId of plan.laterActionIds ?? []) {
          excludeRepo.addToExcludeList(input.campaignId, [personId], actionId);
        }
      }

      // 2. Remove from the current action, grouped per action.
      const byCurrentAction = new Map<number, number[]>();
      for (const [personId, plan] of plans) {
        if (plan.outcome !== "stopped" || plan.currentActionId === undefined) continue;
        const group = byCurrentAction.get(plan.currentActionId) ?? [];
        group.push(personId);
        byCurrentAction.set(plan.currentActionId, group);
      }
      for (const [actionId, group] of byCurrentAction) {
        await campaignService.removePeopleFromAction(input.campaignId, actionId, group);
      }

      // 3. Read back.
      const after = campaignRepo.getPeopleProgress(input.campaignId, personIds);
      const excludedByAction = new Map<number, Set<number>>();
      const excludedOn = (actionId: number): Set<number> => {
        let set = excludedByAction.get(actionId);
        if (set === undefined) {
          set = new Set(
            excludeRepo
              .getExcludeList(input.campaignId, actionId)
              .map((entry) => entry.personId),
          );
          excludedByAction.set(actionId, set);
        }
        return set;
      };

      const people: PersonStopResult[] = personIds.map((personId) => {
        const plan = plans.get(personId) as PersonStopPlan;
        if (plan.outcome !== "stopped" || plan.currentActionId === undefined) {
          return { personId, outcome: plan.outcome };
        }
        const laterActionIds = plan.laterActionIds ?? [];
        return {
          personId,
          outcome: plan.outcome,
          currentActionId: plan.currentActionId,
          excludedActionIds: laterActionIds,
          verified: {
            removedFromCurrentAction:
              after.get(personId)?.latestStateByAction.get(plan.currentActionId) ===
              REMOVED_STATE,
            excludedOnLaterActions: laterActionIds.every((id) =>
              excludedOn(id).has(personId),
            ),
          },
        };
      });

      return {
        success: true as const,
        campaignId: input.campaignId,
        stopped: people.filter((p) => p.outcome === "stopped").length,
        people,
      };
    },
    { db: { readOnly: false } },
  );
}
