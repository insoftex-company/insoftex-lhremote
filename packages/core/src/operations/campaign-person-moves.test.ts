// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/account-resolution.js", () => ({ resolveAccount: vi.fn() }));
vi.mock("../services/instance-context.js", () => ({ withInstanceDatabase: vi.fn() }));
vi.mock("../services/campaign.js", () => ({ CampaignService: vi.fn() }));
vi.mock("../db/index.js", () => ({ CampaignRepository: vi.fn(), CampaignExcludeListRepository: vi.fn() }));

import type { InstanceDatabaseContext } from "../services/instance-context.js";
import { resolveAccount } from "../services/account-resolution.js";
import { withInstanceDatabase } from "../services/instance-context.js";
import { CampaignService } from "../services/campaign.js";
import { CampaignExcludeListRepository, CampaignRepository, type PersonCampaignProgress } from "../db/index.js";
import { campaignMoveOn, campaignPutBack, moveDone, planPersonMoves } from "./campaign-person-moves.js";
import { parseCustomFields } from "./campaign-flags.js";

// Shaped like lhserver's test campaign 158: webhook 709 → Waiter 710 → webhook 711 → Waiter 712 → webhook 713.
const ACTIONS = [709, 710, 711, 712, 713];

function progress(states: Record<number, number>, results: Record<number, number> = {}): PersonCampaignProgress {
  return {
    latestStateByAction: new Map(Object.entries(states).map(([k, v]) => [Number(k), v])),
    resultByAction: new Map(Object.entries(results).map(([k, v]) => [Number(k), v])),
  };
}

describe("planPersonMoves", () => {
  const people = new Map<number, PersonCampaignProgress>([
    [1, progress({ 709: 2, 711: 2 }, { 709: 1, 711: -1 })], // failed at the webhook 711
    [2, progress({ 709: 2, 710: 2 }, { 709: 1, 710: -2 })], // dropped at the Waiter 710 by an exclude
    [3, progress({ 709: 2, 711: 2 }, { 709: 1, 711: 2 })], // replied, held at 711
    [4, progress({ 713: 2 }, { 713: -1 })], // failed at the last action
  ]);

  it("move-on takes only people whose result at the action is Failed (-1)", () => {
    const plan = planPersonMoves("moveOn", ACTIONS, 711, people, [1, 2, 3, 99]);
    expect(plan.eligible).toEqual([1]);
    expect(plan.skipped.map((s) => [s.personId, s.reason])).toEqual([
      [2, "result at the action is none, not -1"],
      [3, "result at the action is 2, not -1"],
      [99, "not in this campaign"],
    ]);
  });

  it("move-on and ignore-reply refuse the last action (rev 7.17: a failure there finishes the run)", () => {
    expect(planPersonMoves("moveOn", ACTIONS, 713, people, [4]).eligible).toEqual([]);
    expect(planPersonMoves("moveOn", ACTIONS, 713, people, [4]).skipped[0]?.reason).toMatch(/last action/);
    expect(planPersonMoves("ignoreReply", ACTIONS, 713, people, [4]).eligible).toEqual([]);
  });

  it("ignore-reply takes Replied (2); put-back takes Excluded (-2), also at the last action", () => {
    expect(planPersonMoves("ignoreReply", ACTIONS, 711, people, [1, 3]).eligible).toEqual([3]);
    expect(planPersonMoves("putBack", ACTIONS, 710, people, [1, 2]).eligible).toEqual([2]);
  });

  it("an action outside the campaign skips everyone", () => {
    expect(planPersonMoves("moveOn", ACTIONS, 1234, people, [1]).skipped[0]?.reason).toBe("the action is not in this campaign");
  });
});

describe("moveDone", () => {
  it("move-on: Skipped (-3) at the action, or present at the next action", () => {
    expect(moveDone("moveOn", { result: -3 })).toBe(true);
    expect(moveDone("moveOn", { result: -1, nextState: 1 })).toBe(true);
    expect(moveDone("moveOn", { result: -1 })).toBe(false);
    expect(moveDone("moveOn", { result: -1, nextState: -1 })).toBe(false);
  });

  it("put-back: queued (1) at the action again, or a result other than Excluded", () => {
    expect(moveDone("putBack", { state: 1, result: -2 })).toBe(true);
    expect(moveDone("putBack", { state: 2, result: -2 })).toBe(false);
  });
});

describe("parseCustomFields", () => {
  it("splits name=value at the first '='; an empty value is allowed (clears the field)", () => {
    expect(parseCustomFields(["segment=FIN-LEND", "note=a=b", "empty="])).toEqual([
      { name: "segment", content: "FIN-LEND" },
      { name: "note", content: "a=b" },
      { name: "empty", content: "" },
    ]);
    expect(() => parseCustomFields(["noequals"])).toThrow(/name=value/);
  });
});

describe("the operations", () => {
  const service = {
    moveToNextAction: vi.fn().mockResolvedValue([1]),
    ignoreRepliesAndMove: vi.fn(),
    retryPeopleAtAction: vi.fn().mockResolvedValue(undefined),
  };
  const removeFromExcludeList = vi.fn().mockReturnValue(1);
  let after = new Map<number, PersonCampaignProgress>();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveAccount).mockResolvedValue(329925);
    vi.mocked(withInstanceDatabase).mockImplementation(async (_port, _account, fn) =>
      fn({ instance: {}, db: {} } as unknown as InstanceDatabaseContext),
    );
    vi.mocked(CampaignService).mockImplementation(function () {
      return service as unknown as CampaignService;
    });
    vi.mocked(CampaignExcludeListRepository).mockImplementation(function () {
      return { removeFromExcludeList } as unknown as CampaignExcludeListRepository;
    });
    let calls = 0;
    vi.mocked(CampaignRepository).mockImplementation(function () {
      return {
          getCampaignActions: () => ACTIONS.map((id) => ({ id })),
          getPeopleProgress: () => {
            calls += 1;
            return calls === 1
              ? new Map([
                  [1, progress({ 711: 2 }, { 711: -1 })],
                  [3, progress({ 711: 2 }, { 711: 1 })],
                ])
              : after;
          },
      } as unknown as CampaignRepository;
    });
  });

  it("move-on calls LinkedHelper for the failed person only (Failed sub-list 4) and reads the move back", async () => {
    after = new Map([[1, progress({ 711: 2, 712: 1 }, { 711: -3 })]]);
    const out = await campaignMoveOn({ campaignId: 158, actionId: 711, personIds: [1, 3] });
    expect(service.moveToNextAction).toHaveBeenCalledWith(158, 711, [1], 4);
    expect(out.nextActionId).toBe(712);
    expect(out.done).toBe(1);
    expect(out.people.find((p) => p.personId === 3)?.outcome).toBe("skipped");
  });

  it("move-on reports notDone when the database does not show the move", async () => {
    after = new Map([[1, progress({ 711: 2 }, { 711: -1 })]]);
    const out = await campaignMoveOn({ campaignId: 158, actionId: 711, personIds: [1] });
    expect(out.done).toBe(0);
    expect(out.people[0]?.outcome).toBe("notDone");
  });

  it("nobody eligible: no LinkedHelper call at all", async () => {
    after = new Map();
    await campaignMoveOn({ campaignId: 158, actionId: 711, personIds: [3] });
    expect(service.moveToNextAction).not.toHaveBeenCalled();
  });

  it("put-back removes the action-level exclude first, then queues again (Excluded sub-list 5)", async () => {
    vi.mocked(CampaignRepository).mockImplementation(function () {
      return {
          getCampaignActions: () => ACTIONS.map((id) => ({ id })),
          getPeopleProgress: vi
            .fn()
            .mockReturnValueOnce(new Map([[2, progress({ 710: 2 }, { 710: -2 })]]))
            .mockReturnValueOnce(new Map([[2, progress({ 710: 1 }, { 710: -2 })]])),
      } as unknown as CampaignRepository;
    });
    const out = await campaignPutBack({ campaignId: 158, actionId: 710, personIds: [2] });
    expect(removeFromExcludeList).toHaveBeenCalledWith(158, [2], 710);
    expect(service.retryPeopleAtAction).toHaveBeenCalledWith(158, 710, [2], 5);
    expect(removeFromExcludeList.mock.invocationCallOrder[0]).toBeLessThan(service.retryPeopleAtAction.mock.invocationCallOrder[0] as number);
    expect(out.done).toBe(1);
  });
});
