// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@insoftex/lhremote-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@insoftex/lhremote-core")>();
  return {
    ...actual,
    importOrganizationsFromUrls: vi.fn(),
  };
});

import {
  CampaignExecutionError,
  CampaignNotFoundError,
  importOrganizationsFromUrls,
} from "@insoftex/lhremote-core";

import { registerImportOrganizationsFromUrls } from "./import-organizations-from-urls.js";
import { describeInfrastructureErrors } from "./testing/infrastructure-errors.js";
import { createMockServer } from "./testing/mock-server.js";
import { describeAccountIdForwarding } from "./testing/account-id-forwarding.js";

const MOCK_RESULT = {
  success: true as const,
  campaignId: 4,
  actionId: 20,
  totalUrls: 2,
  imported: 2,
  alreadyInQueue: 0,
  alreadyProcessed: 0,
  inExcludeList: 0,
  failed: 0,
};

describe("registerImportOrganizationsFromUrls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers a tool named import-organizations-from-urls", () => {
    const { server } = createMockServer();
    registerImportOrganizationsFromUrls(server);

    expect(server.tool).toHaveBeenCalledOnce();
    expect(server.tool).toHaveBeenCalledWith(
      "import-organizations-from-urls",
      expect.any(String),
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("successfully imports organizations from URLs", async () => {
    const { server, getHandler } = createMockServer();
    registerImportOrganizationsFromUrls(server);

    vi.mocked(importOrganizationsFromUrls).mockResolvedValue(MOCK_RESULT);

    const handler = getHandler("import-organizations-from-urls");
    const result = await handler({
      campaignId: 4,
      companyUrls: [
        "https://www.linkedin.com/company/acme",
        "https://www.linkedin.com/company/globex",
      ],
      cdpPort: 9222,
    });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify(MOCK_RESULT, null, 2),
        },
      ],
    });
    expect(importOrganizationsFromUrls).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignId: 4,
        companyUrls: [
          "https://www.linkedin.com/company/acme",
          "https://www.linkedin.com/company/globex",
        ],
        cdpPort: 9222,
      }),
    );
  });

  it("returns error for non-existent campaign", async () => {
    const { server, getHandler } = createMockServer();
    registerImportOrganizationsFromUrls(server);

    vi.mocked(importOrganizationsFromUrls).mockRejectedValue(
      new CampaignNotFoundError(999),
    );

    const handler = getHandler("import-organizations-from-urls");
    const result = await handler({
      campaignId: 999,
      companyUrls: ["https://www.linkedin.com/company/acme"],
      cdpPort: 9222,
    });

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "Campaign 999 not found.",
        },
      ],
    });
  });

  it("returns error when the campaign is a people campaign", async () => {
    const { server, getHandler } = createMockServer();
    registerImportOrganizationsFromUrls(server);

    vi.mocked(importOrganizationsFromUrls).mockRejectedValue(
      new CampaignExecutionError(
        "Campaign 1 is a people campaign — importOrganizationsFromUrls requires an organizations campaign (campaigns.type = 2).",
        1,
      ),
    );

    const handler = getHandler("import-organizations-from-urls");
    const result = await handler({
      campaignId: 1,
      companyUrls: ["https://www.linkedin.com/company/acme"],
      cdpPort: 9222,
    });

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "Failed to import organizations: Campaign 1 is a people campaign — importOrganizationsFromUrls requires an organizations campaign (campaigns.type = 2).",
        },
      ],
    });
  });

  describeInfrastructureErrors(
    registerImportOrganizationsFromUrls,
    "import-organizations-from-urls",
    () => ({
      campaignId: 4,
      companyUrls: ["https://www.linkedin.com/company/acme"],
      cdpPort: 9222,
    }),
    (error) => vi.mocked(importOrganizationsFromUrls).mockRejectedValue(error),
    "Failed to import organizations",
  );
  describeAccountIdForwarding({
    registerTool: registerImportOrganizationsFromUrls,
    toolName: "import-organizations-from-urls",
    mock: vi.mocked(importOrganizationsFromUrls),
    baseArgs: {
      campaignId: 4,
      companyUrls: ["https://www.linkedin.com/company/acme/"],
    },
  });
});
