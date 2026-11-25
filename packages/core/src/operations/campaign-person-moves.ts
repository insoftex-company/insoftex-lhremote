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

/**
 * Three moves of people already in a campaign, used by the Insoftex daily script (CAMPAIGN_RUNS_LHREMOTE_OPS.md):
 *
 * - **move-on**: a person whose webhook (or other step) failed at an action goes on to the next action;
 * - **ignore-reply**: a person LinkedHelper holds at an action because they replied goes on;
 * - **put-back**: a person dropped at an action because of an action-level exclude (-2) is queued there again.
 *
 * Each checks every person's result at the action first (from `lh.db`), calls one LinkedHelper method for the
 * eligible people only, and reads the database back. LinkedHelper result values (`ActionResultStatus`): Skipped -3,
 * Excluded -2, Failed -1, Successful 1, Replied 2. Sub-lists (`ActionSubListType`): Queued 1, Failed 4, Excluded 5,
 * Replied 7 (static read of LinkedHelper 2.140.4).
 */

export const RESULT = { SKIPPED: -3, EXCLUDED: -2, FAILED: -1, SUCCESSFUL: 1, REPLIED: 2 } as const;
export const SUB_LIST = { QUEUED: 1, FAILED: 4, EXCLUDED: 5, REPLIED: 7 } as const;

export type PersonMoveKind = "moveOn" | "ignoreReply" | "putBack";

export interface CampaignPersonMoveInput extends ConnectionOptions {
  readonly campaignId: number;
  /** The action the people are at: the failed action (move-on), the holding action (ignore-reply), the excluded one (put-back). */
  readonly actionId: number;
  readonly personIds: number[];
}

export interface PersonMoveResult {
  readonly personId: number;
  /** `done`: LinkedHelper did it and the database shows it; `notDone`: it was called but the database does not show it. */
  readonly outcome: "done" | "notDone" | "skipped";
  /** Why a person was skipped (not called) or what the database shows instead. */
  readonly reason?: string;
  /** The person's result and latest target state at the action, and the latest state at the next action, after the call. */
  readonly after?: { readonly result?: number | undefined; readonly state?: number | undefined; readonly nextState?: number | undefined };
}

export interface CampaignPersonMoveOutput {
  readonly success: true;
  readonly campaignId: number;
  readonly actionId: number;
  readonly nextActionId: number | null;
  readonly done: number;
  readonly people: PersonMoveResult[];
}

/** The result a person must have at the action for each move. */
const REQUIRED_RESULT: Record<PersonMoveKind, number> = {
  moveOn: RESULT.FAILED,
  ignoreReply: RESULT.REPLIED,
  putBack: RESULT.EXCLUDED,
};

/**
 * Who may be moved: people whose result at the action is the one the move needs. Move-on and ignore-reply refuse the
 * last action (LinkedHelper does nothing there; a failure at the last action finishes the run instead, rev 7.17).
 */
export function planPersonMoves(
  kind: PersonMoveKind,
  actionIds: readonly number[],
  actionId: number,
  progress: ReadonlyMap<number, PersonCampaignProgress>,
  personIds: readonly number[],
): { eligible: number[]; skipped: PersonMoveResult[] } {
  const index = actionIds.indexOf(actionId);
  const skipped: PersonMoveResult[] = [];
  const eligible: number[] = [];
  for (const personId of personIds) {
    if (index === -1) {
      skipped.push({ personId, outcome: "skipped", reason: "the action is not in this campaign" });
      continue;
    }
    if (kind !== "putBack" && index === actionIds.length - 1) {
      skipped.push({ personId, outcome: "skipped", reason: "the last action: there is no next action to move on to" });
      continue;
    }
    const p = progress.get(personId);
    if (p === undefined || p.latestStateByAction.size === 0) {
      skipped.push({ personId, outcome: "skipped", reason: "not in this campaign" });
      continue;
    }
    const result = p.resultByAction.get(actionId);
    if (result !== REQUIRED_RESULT[kind]) {
      skipped.push({
        personId,
        outcome: "skipped",
        reason: `result at the action is ${result === undefined ? "none" : String(result)}, not ${String(REQUIRED_RESULT[kind])}`,
      });
      continue;
    }
    eligible.push(personId);
  }
  return { eligible, skipped };
}

/** Whether the database shows the move done for one person. */
export function moveDone(
  kind: PersonMoveKind,
  after: { result?: number | undefined; state?: number | undefined; nextState?: number | undefined },
): boolean {
  if (kind === "putBack") return after.state === 1 || (after.result !== undefined && after.result !== RESULT.EXCLUDED);
  // move-on and ignore-reply: Skipped at the action and the person present at the next action
  return after.result === RESULT.SKIPPED || (after.nextState !== undefined && after.nextState !== -1);
}

async function runPersonMove(kind: PersonMoveKind, input: CampaignPersonMoveInput): Promise<CampaignPersonMoveOutput> {
  const cdpPort = input.cdpPort;
  const accountId = await resolveAccount(cdpPort, buildCdpOptions(input));

  return withInstanceDatabase(
    cdpPort,
    accountId,
    async ({ instance, db }) => {
      const campaignRepo = new CampaignRepository(db);
      const campaignService = new CampaignService(instance, db);
      const actionIds = campaignRepo.getCampaignActions(input.campaignId).map((a) => a.id);
      if (actionIds.length === 0) {
        throw new CampaignExecutionError(`Campaign ${String(input.campaignId)} has no actions`, input.campaignId);
      }
      const nextActionId = actionIds[actionIds.indexOf(input.actionId) + 1] ?? null;
      const personIds = [...new Set(input.personIds)];
      const before = campaignRepo.getPeopleProgress(input.campaignId, personIds);
      const { eligible, skipped } = planPersonMoves(kind, actionIds, input.actionId, before, personIds);

      if (eligible.length > 0) {
        if (kind === "moveOn") {
          await campaignService.moveToNextAction(input.campaignId, input.actionId, eligible, 4);
        } else if (kind === "ignoreReply") {
          await campaignService.ignoreRepliesAndMove(input.campaignId, input.actionId, eligible);
        } else {
          // the action-level exclude dropped them; it must go first, or LinkedHelper drops them again
          new CampaignExcludeListRepository(db).removeFromExcludeList(input.campaignId, eligible, input.actionId);
          await campaignService.retryPeopleAtAction(input.campaignId, input.actionId, eligible, 5);
        }
      }

      const after = campaignRepo.getPeopleProgress(input.campaignId, eligible);
      const moved: PersonMoveResult[] = eligible.map((personId) => {
        const p = after.get(personId);
        const state = {
          result: p?.resultByAction.get(input.actionId),
          state: p?.latestStateByAction.get(input.actionId),
          nextState: nextActionId === null ? undefined : p?.latestStateByAction.get(nextActionId),
        };
        return moveDone(kind, state)
          ? { personId, outcome: "done" as const, after: state }
          : { personId, outcome: "notDone" as const, reason: "the database does not show the move", after: state };
      });
      const people = [...moved, ...skipped];
      return {
        success: true as const,
        campaignId: input.campaignId,
        actionId: input.actionId,
        nextActionId,
        done: moved.filter((m) => m.outcome === "done").length,
        people,
      };
    },
    { db: { readOnly: false } },
  );
}

/**
 * Move people whose step failed at an action (result -1) on to the next action (`moveToTheNextActionByAction`, the
 * Failed sub-list). Refuses the last action. Reads back a Skipped (-3) result or presence at the next action.
 */
export function campaignMoveOn(input: CampaignPersonMoveInput): Promise<CampaignPersonMoveOutput> {
  return runPersonMove("moveOn", input);
}

/**
 * Ignore the replies of people LinkedHelper holds at an action (result Replied, 2) and move them on
 * (`ignoreRepliesAndMove`, the Replied sub-list 7). Refuses the last action.
 */
export function campaignIgnoreReply(input: CampaignPersonMoveInput): Promise<CampaignPersonMoveOutput> {
  return runPersonMove("ignoreReply", input);
}

/**
 * Put back people dropped at an action by an action-level exclude (result -2): removes that exclude, then queues them
 * at the action again (`retryPeople`, the Excluded sub-list 5). **Experimental** until verified live (whether
 * LinkedHelper re-admits a -2 person this way is not settled by the code read).
 */
export function campaignPutBack(input: CampaignPersonMoveInput): Promise<CampaignPersonMoveOutput> {
  return runPersonMove("putBack", input);
}
