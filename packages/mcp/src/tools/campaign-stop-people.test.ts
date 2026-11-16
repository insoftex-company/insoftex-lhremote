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
  CampaignExecutionError,
  CampaignNotFoundError,
  campaignStopPeople,
  type CampaignStopPeopleOutput,
} from "@insoftex/lhremote-core";

import { registerCampaignStopPeople } from "./campaign-stop-people.js";
import { describeInfrastructureErrors } from "./testing/infrastructure-errors.js";
import { createMockServer } from "./testing/mock-server.js";
import { describeAccountIdForwarding } from "./testing/account-id-forwarding.js";

const RESULT: CampaignStopPeopleOutput = {
  success: true,
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

describe("registerCampaignStopPeople", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers a tool named campaign-stop-people", () => {
    const { server } = createMockServer();
    registerCampaignStopPeople(server);

    expect(server.tool).toHaveBeenCalledOnce();
    expect(server.tool).toHaveBeenCalledWith(
      "campaign-stop-people",
      expect.any(String),
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("returns the per-person stop results", async () => {
    const { server, getHandler } = createMockServer();
    registerCampaignStopPeople(server);
    vi.mocked(campaignStopPeople).mockResolvedValue(RESULT);

    const handler = getHandler("campaign-stop-people");
    const result = await handler({ campaignId: 8, personIds: [3928, 3921], cdpPort: 9222 });

    expect(result).toEqual({
      content: [{ type: "text", text: JSON.stringify(RESULT, null, 2) }],
    });
    expect(campaignStopPeople).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: 8, personIds: [3928, 3921], cdpPort: 9222 }),
    );
  });

  it("returns error for non-existent campaign", async () => {
    const { server, getHandler } = createMockServer();
    registerCampaignStopPeople(server);
    vi.mocked(campaignStopPeople).mockRejectedValue(new CampaignNotFoundError(999));

    const handler = getHandler("campaign-stop-people");
    const result = await handler({ campaignId: 999, personIds: [1], cdpPort: 9222 });

    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "Campaign 999 not found." }],
    });
  });

  it("returns error when the stop fails", async () => {
    const { server, getHandler } = createMockServer();
    registerCampaignStopPeople(server);
    vi.mocked(campaignStopPeople).mockRejectedValue(
      new CampaignExecutionError("Campaign 8 has no actions", 8),
    );

    const handler = getHandler("campaign-stop-people");
    const result = await handler({ campaignId: 8, personIds: [1], cdpPort: 9222 });

    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "Failed to stop people: Campaign 8 has no actions" }],
    });
  });

  describeInfrastructureErrors(
    registerCampaignStopPeople,
    "campaign-stop-people",
    () => ({ campaignId: 8, personIds: [1], cdpPort: 9222 }),
    (error) => vi.mocked(campaignStopPeople).mockRejectedValue(error),
    "Failed to stop people",
  );
  describeAccountIdForwarding({
    registerTool: registerCampaignStopPeople,
    toolName: "campaign-stop-people",
    mock: vi.mocked(campaignStopPeople),
    baseArgs: { campaignId: 1, personIds: [1] },
  });
});
