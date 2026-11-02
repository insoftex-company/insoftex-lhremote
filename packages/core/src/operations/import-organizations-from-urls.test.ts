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

import type { InstanceDatabaseContext } from "../services/instance-context.js";
import { resolveAccount } from "../services/account-resolution.js";
import { withInstanceDatabase } from "../services/instance-context.js";
import { CampaignService } from "../services/campaign.js";
import { IMPORT_CHUNK_SIZE } from "./import-people-from-urls.js";
import { importOrganizationsFromUrls } from "./import-organizations-from-urls.js";

const MOCK_IMPORT_RESULT = {
  actionId: 20,
  successful: 3,
  alreadyInQueue: 1,
  alreadyProcessed: 0,
  inExcludeList: 0,
  failed: 0,
};

function mockDatabaseContext() {
  vi.mocked(withInstanceDatabase).mockImplementation(
    async (_cdpPort, _accountId, callback) =>
      callback({
        accountId: 1,
        instance: {},
        db: {},
      } as unknown as InstanceDatabaseContext),
  );
}

function setupMocks() {
  vi.mocked(resolveAccount).mockResolvedValue(1);
  mockDatabaseContext();
  vi.mocked(CampaignService).mockImplementation(function () {
    return {
      importOrganizationsFromUrls: vi.fn().mockResolvedValue(MOCK_IMPORT_RESULT),
    } as unknown as CampaignService;
  });
}

describe("importOrganizationsFromUrls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns import results with totalUrls", async () => {
    setupMocks();

    const result = await importOrganizationsFromUrls({
      campaignId: 4,
      companyUrls: [
        "https://linkedin.com/company/acme",
        "https://linkedin.com/company/globex",
      ],
      cdpPort: 9222,
    });

    expect(result.success).toBe(true);
    expect(result.campaignId).toBe(4);
    expect(result.actionId).toBe(20);
    expect(result.totalUrls).toBe(2);
    expect(result.imported).toBe(3);
    expect(result.alreadyInQueue).toBe(1);
    expect(result.alreadyProcessed).toBe(0);
    expect(result.inExcludeList).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("passes connection options to resolveAccount", async () => {
    setupMocks();

    await importOrganizationsFromUrls({
      campaignId: 4,
      companyUrls: ["https://linkedin.com/company/acme"],
      cdpPort: 1234,
      cdpHost: "192.168.1.1",
      allowRemote: true,
    });

    expect(resolveAccount).toHaveBeenCalledWith(1234, {
      host: "192.168.1.1",
      allowRemote: true,
    });
  });

  it("propagates resolveAccount errors", async () => {
    vi.mocked(resolveAccount).mockRejectedValue(new Error("connection refused"));

    await expect(
      importOrganizationsFromUrls({
        campaignId: 4,
        companyUrls: ["https://linkedin.com/company/acme"],
        cdpPort: 9222,
      }),
    ).rejects.toThrow("connection refused");
  });

  it("propagates CampaignService errors", async () => {
    vi.mocked(resolveAccount).mockResolvedValue(1);
    mockDatabaseContext();
    vi.mocked(CampaignService).mockImplementation(function () {
      return {
        importOrganizationsFromUrls: vi
          .fn()
          .mockRejectedValue(new Error("campaign not found")),
      } as unknown as CampaignService;
    });

    await expect(
      importOrganizationsFromUrls({
        campaignId: 4,
        companyUrls: ["https://linkedin.com/company/acme"],
        cdpPort: 9222,
      }),
    ).rejects.toThrow("campaign not found");
  });

  it("chunks URLs exceeding IMPORT_CHUNK_SIZE into multiple calls", async () => {
    const mockImport = vi.fn().mockResolvedValue(MOCK_IMPORT_RESULT);
    vi.mocked(resolveAccount).mockResolvedValue(1);
    mockDatabaseContext();
    vi.mocked(CampaignService).mockImplementation(function () {
      return {
        importOrganizationsFromUrls: mockImport,
      } as unknown as CampaignService;
    });

    const totalUrls = IMPORT_CHUNK_SIZE + 50;
    const urls = Array.from(
      { length: totalUrls },
      (_, i) => `https://linkedin.com/company/org-${String(i)}`,
    );
    await importOrganizationsFromUrls({ campaignId: 4, companyUrls: urls, cdpPort: 9222 });

    expect(mockImport).toHaveBeenCalledTimes(2);
    expect(mockImport).toHaveBeenNthCalledWith(1, 4, urls.slice(0, IMPORT_CHUNK_SIZE));
    expect(mockImport).toHaveBeenNthCalledWith(2, 4, urls.slice(IMPORT_CHUNK_SIZE));
  });

  it("aggregates results across chunks", async () => {
    const mockImport = vi
      .fn()
      .mockResolvedValueOnce({
        actionId: 20,
        successful: 150,
        alreadyInQueue: 30,
        alreadyProcessed: 15,
        inExcludeList: 3,
        failed: 5,
      })
      .mockResolvedValueOnce({
        actionId: 20,
        successful: 40,
        alreadyInQueue: 5,
        alreadyProcessed: 3,
        inExcludeList: 1,
        failed: 2,
      });
    vi.mocked(resolveAccount).mockResolvedValue(1);
    mockDatabaseContext();
    vi.mocked(CampaignService).mockImplementation(function () {
      return {
        importOrganizationsFromUrls: mockImport,
      } as unknown as CampaignService;
    });

    const totalUrls = IMPORT_CHUNK_SIZE + 50;
    const urls = Array.from(
      { length: totalUrls },
      (_, i) => `https://linkedin.com/company/org-${String(i)}`,
    );
    const result = await importOrganizationsFromUrls({
      campaignId: 4,
      companyUrls: urls,
      cdpPort: 9222,
    });

    expect(result).toEqual({
      success: true,
      campaignId: 4,
      actionId: 20,
      totalUrls,
      imported: 190,
      alreadyInQueue: 35,
      alreadyProcessed: 18,
      inExcludeList: 4,
      failed: 7,
    });
  });
});
