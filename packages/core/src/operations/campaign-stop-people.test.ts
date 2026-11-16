// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/account-resolution.js", () => ({
  resolveAccount: vi.fn(),
}));

vi.mock("../services/instance-context.js", () => ({
  withInstanceDatabase: vi.fn(),
}));

vi.mock("../services/campaign.js", () => ({
  CampaignService: vi.fn(),
}));

vi.mock("../db/index.js", () => ({
  CampaignRepository: vi.fn(),
  CampaignExcludeListRepository: vi.fn(),
}));

import type { InstanceDatabaseContext } from "../services/instance-context.js";
import { resolveAccount } from "../services/account-resolution.js";
import { withInstanceDatabase } from "../services/instance-context.js";
import { CampaignService } from "../services/campaign.js";
import {
  CampaignExcludeListRepository,
  CampaignRepository,
  type PersonCampaignProgress,
} from "../db/index.js";
import { CampaignExecutionError } from "../services/errors.js";
import { campaignStopPeople, planPersonStop } from "./campaign-stop-people.js";

// Campaign shaped like the T0.5 test campaign: webhook 38 → Waiter 39 →
// webhook 40 → Waiter 41 → webhook 42.
const ACTIONS = [38, 39, 40, 41, 42];

function progress(
  states: Record<number, number>,
  results: Record<number, number> = {},
): PersonCampaignProgress {
  return {
    latestStateByAction: new Map(Object.entries(states).map(([k, v]) => [Number(k), v])),
    resultByAction: new Map(Object.entries(results).map(([k, v]) => [Number(k), v])),
  };
}

describe("planPersonStop", () => {
  it("queued at the first action: removes there, excludes every later action", () => {
    expect(planPersonStop(ACTIONS, progress({ 38: 1 }))).toEqual({
      outcome: "stopped",
      currentActionId: 38,
      laterActionIds: [39, 40, 41, 42],
    });
  });

  it("waiting in the first Waiter: current action is the Waiter", () => {
    // /entry done (result at 38), entered 39 (state 2).
    expect(planPersonStop(ACTIONS, progress({ 38: 1, 39: 2 }, { 38: 1 }))).toEqual({
      outcome: "stopped",
      currentActionId: 39,
      laterActionIds: [40, 41, 42],
    });
  });

  it("past the middle webhook: current action is the second Waiter", () => {
    expect(
      planPersonStop(
        ACTIONS,
        progress({ 38: 1, 39: 2, 40: 2, 41: 2 }, { 38: 1, 39: 1, 40: 1 }),
      ),
    ).toEqual({ outcome: "stopped", currentActionId: 41, laterActionIds: [42] });
  });

  it("result for the last action: finished, nothing to stop", () => {
    expect(
      planPersonStop(
        ACTIONS,
        progress({ 38: 1, 39: 2, 40: 2, 41: 2, 42: 2 }, { 38: 1, 39: 1, 40: 1, 41: 1, 42: 1 }),
      ),
    ).toEqual({ outcome: "finished" });
  });

  it("already removed from the current action: alreadyStopped", () => {
    expect(planPersonStop(ACTIONS, progress({ 38: 1, 39: -1 }, { 38: 1 }))).toEqual({
      outcome: "alreadyStopped",
    });
  });

  it("no rows: notInCampaign", () => {
    expect(planPersonStop(ACTIONS, progress({}))).toEqual({ outcome: "notInCampaign" });
    expect(planPersonStop(ACTIONS, undefined)).toEqual({ outcome: "notInCampaign" });
  });

  it("dropped at an action by an exclude (result -2) counts as having left it", () => {
    // D2: excluded at 40 → result -2 at 40, no rows after it.
    expect(
      planPersonStop(ACTIONS, progress({ 38: 1, 39: 2, 40: 2 }, { 38: 1, 39: 1, 40: -2 })),
    ).toEqual({ outcome: "alreadyStopped" });
  });
});

describe("campaignStopPeople", () => {
  const calls: string[] = [];
  let progressBefore: Map<number, PersonCampaignProgress>;
  let progressAfter: Map<number, PersonCampaignProgress>;
  let excluded: Map<number, Set<number>>;

  function setupMocks(actions = ACTIONS) {
    calls.length = 0;
    excluded = new Map();
    vi.mocked(resolveAccount).mockResolvedValue(1);
    vi.mocked(withInstanceDatabase).mockImplementation(
      async (_cdpPort, _accountId, callback) =>
        callback({ accountId: 1, instance: {}, db: {} } as unknown as InstanceDatabaseContext),
    );

    let progressCalls = 0;
    vi.mocked(CampaignRepository).mockImplementation(function () {
      return {
        getCampaignActions: vi.fn().mockReturnValue(actions.map((id) => ({ id }))),
        getPeopleProgress: vi.fn().mockImplementation(() => {
          progressCalls++;
          return progressCalls === 1 ? progressBefore : progressAfter;
        }),
      } as unknown as CampaignRepository;
    });

    vi.mocked(CampaignExcludeListRepository).mockImplementation(function () {
      return {
        addToExcludeList: vi.fn().mockImplementation(
          (_campaignId: number, personIds: number[], actionId: number) => {
            calls.push(`exclude ${String(actionId)}:${personIds.join(",")}`);
            const set = excluded.get(actionId) ?? new Set<number>();
            personIds.forEach((id) => set.add(id));
            excluded.set(actionId, set);
            return personIds.length;
          },
        ),
        getExcludeList: vi.fn().mockImplementation((_campaignId: number, actionId: number) =>
          [...(excluded.get(actionId) ?? [])].map((personId) => ({ personId })),
        ),
      } as unknown as CampaignExcludeListRepository;
    });

    vi.mocked(CampaignService).mockImplementation(function () {
      return {
        removePeopleFromAction: vi.fn().mockImplementation(
          async (_campaignId: number, actionId: number, personIds: number[]) => {
            calls.push(`remove ${String(actionId)}:${personIds.join(",")}`);
            return { actionId, removed: personIds.length };
          },
        ),
      } as unknown as CampaignService;
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("excludes on later actions before removing from the current action", async () => {
    progressBefore = new Map([[3928, progress({ 38: 1, 39: 2 }, { 38: 1 })]]);
    progressAfter = new Map([[3928, progress({ 38: 1, 39: -1 }, { 38: 1 })]]);
    setupMocks();

    const result = await campaignStopPeople({ campaignId: 8, personIds: [3928], cdpPort: 9222 });

    expect(calls).toEqual(["exclude 40:3928", "exclude 41:3928", "exclude 42:3928", "remove 39:3928"]);
    expect(result.stopped).toBe(1);
    expect(result.people[0]).toEqual({
      personId: 3928,
      outcome: "stopped",
      currentActionId: 39,
      excludedActionIds: [40, 41, 42],
      verified: { removedFromCurrentAction: true, excludedOnLaterActions: true },
    });
  });

  it("groups removals per current action and skips finished or absent people", async () => {
    progressBefore = new Map([
      [1, progress({ 38: 1, 39: 2 }, { 38: 1 })],
      [2, progress({ 38: 1, 39: 2 }, { 38: 1 })],
      [3, progress({ 38: 1 })],
      [4, progress({ 38: 1, 39: 2, 40: 2, 41: 2, 42: 2 }, { 38: 1, 39: 1, 40: 1, 41: 1, 42: 1 })],
      [5, progress({})],
    ]);
    progressAfter = progressBefore;
    setupMocks();

    const result = await campaignStopPeople({ campaignId: 8, personIds: [1, 2, 3, 4, 5, 1] });

    expect(calls.filter((c) => c.startsWith("remove"))).toEqual(["remove 39:1,2", "remove 38:3"]);
    expect(result.people.map((p) => [p.personId, p.outcome])).toEqual([
      [1, "stopped"],
      [2, "stopped"],
      [3, "stopped"],
      [4, "finished"],
      [5, "notInCampaign"],
    ]);
    expect(result.stopped).toBe(3);
  });

  it("reports a removal that didn't take", async () => {
    progressBefore = new Map([[7, progress({ 38: 1, 39: 2 }, { 38: 1 })]]);
    progressAfter = progressBefore; // still state 2 at 39 after the call
    setupMocks();

    const result = await campaignStopPeople({ campaignId: 8, personIds: [7] });

    expect(result.people[0]?.verified).toEqual({
      removedFromCurrentAction: false,
      excludedOnLaterActions: true,
    });
  });

  it("throws CampaignExecutionError for a campaign without actions", async () => {
    progressBefore = new Map();
    progressAfter = new Map();
    setupMocks([]);

    await expect(campaignStopPeople({ campaignId: 8, personIds: [1] })).rejects.toThrow(
      CampaignExecutionError,
    );
  });
});
