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

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(),
  };
});

import {
  type CampaignListOrganizationsOutput,
  ActionNotFoundError,
  CampaignNotFoundError,
  campaignListOrganizations,
} from "@insoftex/lhremote-core";
import { readFileSync } from "node:fs";

import { handleCampaignListOrganizations } from "./campaign-list-organizations.js";
import { getStdout } from "./testing/mock-helpers.js";

const MOCK_RESULT: CampaignListOrganizationsOutput = {
  campaignId: 4,
  organizations: [
    {
      organizationId: 1,
      name: "Acme Robotics",
      publicId: "acme-robotics",
      companyId: "27109959",
      status: "queued",
      currentActionId: 20,
    },
    {
      organizationId: 2,
      name: null,
      publicId: null,
      companyId: "1389",
      status: "processed",
      currentActionId: 20,
    },
  ],
  total: 2,
  limit: 20,
  offset: 0,
};

describe("handleCampaignListOrganizations", () => {
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

  it("prints human-readable organizations list", async () => {
    vi.mocked(campaignListOrganizations).mockResolvedValue(MOCK_RESULT);

    await handleCampaignListOrganizations(4, {});

    expect(process.exitCode).toBeUndefined();
    const output = getStdout(stdoutSpy);
    expect(output).toContain("Campaign #4 Organizations (2 total)");
    expect(output).toContain("#1 Acme Robotics (acme-robotics) — queued at action #20");
    expect(output).toContain("#2 (unnamed) (1389) — processed at action #20");
  });

  it("prints JSON with --json", async () => {
    vi.mocked(campaignListOrganizations).mockResolvedValue(MOCK_RESULT);

    await handleCampaignListOrganizations(4, { json: true });

    expect(process.exitCode).toBeUndefined();
    const parsed = JSON.parse(getStdout(stdoutSpy));
    expect(parsed.campaignId).toBe(4);
    expect(parsed.organizations).toHaveLength(2);
  });

  it("prints empty message when no organizations found", async () => {
    vi.mocked(campaignListOrganizations).mockResolvedValue({
      ...MOCK_RESULT,
      organizations: [],
      total: 0,
    });

    await handleCampaignListOrganizations(4, {});

    expect(getStdout(stdoutSpy)).toContain("No organizations found.");
  });

  it("passes actionId, status, limit, and offset options", async () => {
    vi.mocked(campaignListOrganizations).mockResolvedValue(MOCK_RESULT);

    await handleCampaignListOrganizations(4, {
      actionId: 20,
      status: "queued",
      limit: 10,
      offset: 5,
    });

    expect(campaignListOrganizations).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignId: 4,
        actionId: 20,
        status: "queued",
        limit: 10,
        offset: 5,
      }),
    );
  });

  it("sets exitCode 1 when campaign not found", async () => {
    vi.mocked(campaignListOrganizations).mockRejectedValue(
      new CampaignNotFoundError(999),
    );

    await handleCampaignListOrganizations(999, {});

    expect(process.exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith("Campaign 999 not found.\n");
  });

  it("sets exitCode 1 when action not found", async () => {
    vi.mocked(campaignListOrganizations).mockRejectedValue(
      new ActionNotFoundError(99, 4),
    );

    await handleCampaignListOrganizations(4, { actionId: 99 });

    expect(process.exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      "Action 99 not found in campaign 4.\n",
    );
  });

  describe("--urls / --urls-file", () => {
    it("parses --urls into companyUrls", async () => {
      vi.mocked(campaignListOrganizations).mockResolvedValue(MOCK_RESULT);

      await handleCampaignListOrganizations(4, {
        urls: "https://linkedin.com/company/acme,https://linkedin.com/company/globex",
      });

      expect(campaignListOrganizations).toHaveBeenCalledWith(
        expect.objectContaining({
          companyUrls: [
            "https://linkedin.com/company/acme",
            "https://linkedin.com/company/globex",
          ],
        }),
      );
    });

    it("reads --urls-file into companyUrls", async () => {
      vi.mocked(readFileSync).mockReturnValue(
        "https://linkedin.com/company/acme\nhttps://linkedin.com/company/globex",
      );
      vi.mocked(campaignListOrganizations).mockResolvedValue(MOCK_RESULT);

      await handleCampaignListOrganizations(4, { urlsFile: "urls.txt" });

      expect(campaignListOrganizations).toHaveBeenCalledWith(
        expect.objectContaining({
          companyUrls: [
            "https://linkedin.com/company/acme",
            "https://linkedin.com/company/globex",
          ],
        }),
      );
    });

    it("sets exitCode 1 when both --urls and --urls-file are given", async () => {
      await handleCampaignListOrganizations(4, {
        urls: "https://linkedin.com/company/acme",
        urlsFile: "urls.txt",
      });

      expect(process.exitCode).toBe(1);
      expect(stderrSpy).toHaveBeenCalledWith(
        "Use only one of --urls or --urls-file.\n",
      );
    });

    it("prints notFoundCompanyUrls when present", async () => {
      vi.mocked(campaignListOrganizations).mockResolvedValue({
        ...MOCK_RESULT,
        notFoundCompanyUrls: ["https://linkedin.com/company/nobody"],
      });

      await handleCampaignListOrganizations(4, {
        urls: "https://linkedin.com/company/acme,https://linkedin.com/company/nobody",
      });

      const output = getStdout(stdoutSpy);
      expect(output).toContain("1 of the given URLs are not on the target list:");
      expect(output).toContain("https://linkedin.com/company/nobody");
    });

    it("omits the not-found section when notFoundCompanyUrls is absent", async () => {
      vi.mocked(campaignListOrganizations).mockResolvedValue(MOCK_RESULT);

      await handleCampaignListOrganizations(4, {});

      expect(getStdout(stdoutSpy)).not.toContain("not on the target list");
    });
  });
});
