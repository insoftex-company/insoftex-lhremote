// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/account-resolution.js", () => ({
  resolveAccount: vi.fn(),
}));

vi.mock("../services/instance-context.js", () => ({
  withDatabase: vi.fn(),
}));

vi.mock("../db/index.js", () => ({
  CampaignRepository: vi.fn(),
}));

import type { DatabaseContext } from "../services/instance-context.js";
import { resolveAccount } from "../services/account-resolution.js";
import { withDatabase } from "../services/instance-context.js";
import { CampaignRepository } from "../db/index.js";
import { campaignListOrganizations } from "./campaign-list-organizations.js";

const MOCK_ORGANIZATIONS = {
  organizations: [
    {
      organizationId: 1,
      name: "Acme Robotics",
      publicId: "acme-robotics",
      companyId: "27109959",
      status: "queued" as const,
      currentActionId: 20,
    },
    {
      organizationId: 2,
      name: "Globex",
      publicId: null,
      companyId: "1389",
      status: "processed" as const,
      currentActionId: 20,
    },
  ],
  total: 2,
};

// Ground truth mirroring MOCK_ORGANIZATIONS, used by the matchedCompanyIds
// mock below — the operation now derives notFoundCompanyUrls from that
// dedicated repository method rather than from listOrganizations's output.
const KNOWN_COMPANY_IDS = new Set(["ACME-ROBOTICS", "27109959", "1389"]);

function setupMocks() {
  vi.mocked(resolveAccount).mockResolvedValue(1);

  vi.mocked(withDatabase).mockImplementation(
    async (_accountId, callback) =>
      callback({ db: {} } as unknown as DatabaseContext),
  );

  vi.mocked(CampaignRepository).mockImplementation(function () {
    return {
      listOrganizations: vi.fn().mockReturnValue(MOCK_ORGANIZATIONS),
      matchedCompanyIds: vi
        .fn()
        .mockImplementation(
          (_campaignId: number, ids: string[]) =>
            new Set(ids.filter((id) => KNOWN_COMPANY_IDS.has(id))),
        ),
    } as unknown as CampaignRepository;
  });
}

function lastRepoInstance() {
  return (
    vi.mocked(CampaignRepository).mock.results[0] as {
      value: InstanceType<typeof CampaignRepository>;
    }
  ).value;
}

describe("campaignListOrganizations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns organizations for a campaign", async () => {
    setupMocks();

    const result = await campaignListOrganizations({
      campaignId: 4,
      cdpPort: 9222,
    });

    expect(result.campaignId).toBe(4);
    expect(result.organizations).toHaveLength(2);
    expect(result.organizations[0]?.organizationId).toBe(1);
    expect(result.total).toBe(2);
    expect(result.limit).toBe(20);
    expect(result.offset).toBe(0);
  });

  it("passes actionId, status, limit, and offset to repository", async () => {
    setupMocks();

    await campaignListOrganizations({
      campaignId: 4,
      cdpPort: 9222,
      actionId: 20,
      status: "queued",
      limit: 10,
      offset: 20,
    });

    expect(lastRepoInstance().listOrganizations).toHaveBeenCalledWith(4, {
      actionId: 20,
      status: "queued",
      limit: 10,
      offset: 20,
    });
  });

  it("propagates resolveAccount errors", async () => {
    vi.mocked(resolveAccount).mockRejectedValue(
      new Error("connection refused"),
    );

    await expect(
      campaignListOrganizations({ campaignId: 4, cdpPort: 9222 }),
    ).rejects.toThrow("connection refused");
  });

  it("propagates CampaignRepository errors", async () => {
    vi.mocked(resolveAccount).mockResolvedValue(1);
    vi.mocked(withDatabase).mockImplementation(
      async (_accountId, callback) =>
        callback({ db: {} } as unknown as DatabaseContext),
    );
    vi.mocked(CampaignRepository).mockImplementation(function () {
      return {
        listOrganizations: vi.fn().mockImplementation(() => {
          throw new Error("repository error");
        }),
      } as unknown as CampaignRepository;
    });

    await expect(
      campaignListOrganizations({ campaignId: 4, cdpPort: 9222 }),
    ).rejects.toThrow("repository error");
  });

  describe("companyUrls filter", () => {
    it("translates URLs to uppercased company IDs and passes them to the repository", async () => {
      setupMocks();

      await campaignListOrganizations({
        campaignId: 4,
        cdpPort: 9222,
        companyUrls: [
          "https://www.linkedin.com/company/acme-robotics/",
          "https://www.linkedin.com/company/1389",
        ],
      });

      expect(lastRepoInstance().listOrganizations).toHaveBeenCalledWith(4, {
        companyIds: ["ACME-ROBOTICS", "1389"],
        limit: 2,
        offset: 0,
      });
    });

    it("returns notFoundCompanyUrls for URLs with no matching target", async () => {
      setupMocks();

      const result = await campaignListOrganizations({
        campaignId: 4,
        cdpPort: 9222,
        companyUrls: [
          "https://www.linkedin.com/company/acme-robotics/",
          "https://www.linkedin.com/company/1389",
          "https://www.linkedin.com/company/nobody-here/",
        ],
      });

      expect(result.notFoundCompanyUrls).toEqual([
        "https://www.linkedin.com/company/nobody-here/",
      ]);
    });

    it("matches found URLs case-insensitively", async () => {
      setupMocks();

      const result = await campaignListOrganizations({
        campaignId: 4,
        cdpPort: 9222,
        companyUrls: ["https://www.linkedin.com/company/ACME-Robotics/"],
      });

      expect(result.notFoundCompanyUrls).toEqual([]);
    });

    it("omits notFoundCompanyUrls when companyUrls was not given", async () => {
      setupMocks();

      const result = await campaignListOrganizations({
        campaignId: 4,
        cdpPort: 9222,
      });

      expect(result.notFoundCompanyUrls).toBeUndefined();
      expect(lastRepoInstance().matchedCompanyIds).not.toHaveBeenCalled();
    });

    it("derives notFoundCompanyUrls from matchedCompanyIds, not listOrganizations's output", async () => {
      setupMocks();

      await campaignListOrganizations({
        campaignId: 4,
        cdpPort: 9222,
        companyUrls: [
          "https://www.linkedin.com/company/acme-robotics/",
          "https://www.linkedin.com/company/1389",
        ],
      });

      expect(lastRepoInstance().matchedCompanyIds).toHaveBeenCalledWith(4, [
        "ACME-ROBOTICS",
        "1389",
      ]);
    });

    it("throws on malformed company URLs before any DB access", async () => {
      setupMocks();

      await expect(
        campaignListOrganizations({
          campaignId: 4,
          cdpPort: 9222,
          companyUrls: ["https://www.linkedin.com/in/jane-doe/"],
        }),
      ).rejects.toThrow("Invalid LinkedIn company URL");

      expect(withDatabase).not.toHaveBeenCalled();
    });

    it("caps the default limit at IMPORT_CHUNK_SIZE for large URL batches", async () => {
      setupMocks();

      const manyUrls = Array.from(
        { length: 250 },
        (_, i) => `https://www.linkedin.com/company/org-${String(i)}/`,
      );

      await campaignListOrganizations({
        campaignId: 4,
        cdpPort: 9222,
        companyUrls: manyUrls,
      });

      expect(lastRepoInstance().listOrganizations).toHaveBeenCalledWith(
        4,
        expect.objectContaining({ limit: 200 }),
      );
    });
  });
});
