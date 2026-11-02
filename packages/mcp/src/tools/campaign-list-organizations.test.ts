// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@insoftex/lhremote-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@insoftex/lhremote-core")>();
  return {
    ...actual,
    campaignListOrganizations: vi.fn(),
  };
});

import {
  ActionNotFoundError,
  campaignListOrganizations,
} from "@insoftex/lhremote-core";

import { registerCampaignListOrganizations } from "./campaign-list-organizations.js";
import { describeInfrastructureErrors } from "./testing/infrastructure-errors.js";
import { createMockServer } from "./testing/mock-server.js";
import { describeAccountIdForwarding } from "./testing/account-id-forwarding.js";

const MOCK_RESULT = {
  campaignId: 4,
  organizations: [
    {
      organizationId: 1,
      name: "Acme Robotics",
      publicId: "acme-robotics",
      companyId: "27109959",
      status: "queued" as const,
      currentActionId: 20,
    },
  ],
  total: 1,
  limit: 20,
  offset: 0,
};

describe("registerCampaignListOrganizations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers a tool named campaign-list-organizations", () => {
    const { server } = createMockServer();
    registerCampaignListOrganizations(server);

    expect(server.tool).toHaveBeenCalledOnce();
    expect(server.tool).toHaveBeenCalledWith(
      "campaign-list-organizations",
      expect.any(String),
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("lists organizations for a campaign", async () => {
    const { server, getHandler } = createMockServer();
    registerCampaignListOrganizations(server);

    vi.mocked(campaignListOrganizations).mockResolvedValue(MOCK_RESULT);

    const handler = getHandler("campaign-list-organizations");
    const result = await handler({ campaignId: 4, cdpPort: 9222 });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify(MOCK_RESULT, null, 2),
        },
      ],
    });
  });

  it("forwards filters and companyUrls to the operation", async () => {
    const { server, getHandler } = createMockServer();
    registerCampaignListOrganizations(server);

    vi.mocked(campaignListOrganizations).mockResolvedValue(MOCK_RESULT);

    const handler = getHandler("campaign-list-organizations");
    await handler({
      campaignId: 4,
      actionId: 20,
      status: "queued",
      companyUrls: ["https://www.linkedin.com/company/acme"],
      limit: 5,
      offset: 10,
      cdpPort: 9222,
    });

    expect(campaignListOrganizations).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignId: 4,
        actionId: 20,
        status: "queued",
        companyUrls: ["https://www.linkedin.com/company/acme"],
        limit: 5,
        offset: 10,
      }),
    );
  });

  it("returns error when action not found", async () => {
    const { server, getHandler } = createMockServer();
    registerCampaignListOrganizations(server);

    vi.mocked(campaignListOrganizations).mockRejectedValue(
      new ActionNotFoundError(99, 4),
    );

    const handler = getHandler("campaign-list-organizations");
    const result = await handler({ campaignId: 4, actionId: 99, cdpPort: 9222 });

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "Action 99 not found in campaign 4.",
        },
      ],
    });
  });

  describeInfrastructureErrors(
    registerCampaignListOrganizations,
    "campaign-list-organizations",
    () => ({ campaignId: 4, cdpPort: 9222 }),
    (error) => vi.mocked(campaignListOrganizations).mockRejectedValue(error),
    "Failed to list campaign organizations",
  );
  describeAccountIdForwarding({
    registerTool: registerCampaignListOrganizations,
    toolName: "campaign-list-organizations",
    mock: vi.mocked(campaignListOrganizations),
    baseArgs: { campaignId: 4 },
  });
});
