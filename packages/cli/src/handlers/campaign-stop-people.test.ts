// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@insoftex/lhremote-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@insoftex/lhremote-core")>();
  return {
    ...actual,
    campaignStopPeople: vi.fn(),
  };
});

import {
  type CampaignStopPeopleOutput,
  CampaignNotFoundError,
  campaignStopPeople,
} from "@insoftex/lhremote-core";

import { handleCampaignStopPeople } from "./campaign-stop-people.js";
import { getStderr, getStdout } from "./testing/mock-helpers.js";

const VERIFIED: CampaignStopPeopleOutput = {
  success: true as const,
  campaignId: 8,
  stopped: 1,
  people: [
    {
      personId: 3928,
      outcome: "stopped",
      currentActionId: 39,
      excludedActionIds: [40, 41, 42],
      verified: { removedFromCurrentAction: true, excludedOnLaterActions: true },
    },
    { personId: 3921, outcome: "finished" },
  ],
};

describe("handleCampaignStopPeople", () => {
  const originalExitCode = process.exitCode;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.exitCode = undefined;
    vi.clearAllMocks();
    stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it("prints per-person outcomes", async () => {
    vi.mocked(campaignStopPeople).mockResolvedValue(VERIFIED);

    await handleCampaignStopPeople(8, { personIds: "3928,3921" });

    expect(process.exitCode).toBeUndefined();
    const out = getStdout(stdoutSpy);
    expect(out).toContain("Stopped 1 of 2 person(s) in campaign 8.");
    expect(out).toContain("3928: stopped at action 39, excluded on [40, 41, 42]");
    expect(out).toContain("3921: finished");
  });

  it("flags an unverified stop and sets a failing exit code", async () => {
    vi.mocked(campaignStopPeople).mockResolvedValue({
      ...VERIFIED,
      people: [
        {
          personId: 3928,
          outcome: "stopped",
          currentActionId: 39,
          excludedActionIds: [40, 41, 42],
          verified: { removedFromCurrentAction: false, excludedOnLaterActions: true },
        },
      ],
    });

    await handleCampaignStopPeople(8, { personIds: "3928" });

    expect(process.exitCode).toBe(1);
    expect(getStdout(stdoutSpy)).toContain("NOT VERIFIED");
  });

  it("prints JSON with --json", async () => {
    vi.mocked(campaignStopPeople).mockResolvedValue(VERIFIED);

    await handleCampaignStopPeople(8, { personIds: "3928,3921", json: true });

    expect(JSON.parse(getStdout(stdoutSpy))).toEqual(VERIFIED);
  });

  it("reports a missing campaign", async () => {
    vi.mocked(campaignStopPeople).mockRejectedValue(new CampaignNotFoundError(999));

    await handleCampaignStopPeople(999, { personIds: "1" });

    expect(process.exitCode).toBe(1);
    expect(getStderr(stderrSpy)).toContain("Campaign 999 not found.");
  });

  it("rejects a call without person ids", async () => {
    await handleCampaignStopPeople(8, {});

    expect(process.exitCode).toBe(1);
    expect(campaignStopPeople).not.toHaveBeenCalled();
  });
});
