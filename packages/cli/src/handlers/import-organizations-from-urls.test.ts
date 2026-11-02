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

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(),
  };
});

import {
  type ImportOrganizationsFromUrlsOutput,
  CampaignExecutionError,
  CampaignNotFoundError,
  InstanceNotRunningError,
  importOrganizationsFromUrls,
} from "@insoftex/lhremote-core";
import { readFileSync } from "node:fs";

import { handleImportOrganizationsFromUrls } from "./import-organizations-from-urls.js";
import { getStdout } from "./testing/mock-helpers.js";

const MOCK_RESULT: ImportOrganizationsFromUrlsOutput = {
  success: true as const,
  campaignId: 4,
  actionId: 20,
  totalUrls: 3,
  imported: 3,
  alreadyInQueue: 1,
  alreadyProcessed: 0,
  inExcludeList: 0,
  failed: 0,
};

describe("handleImportOrganizationsFromUrls", () => {
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

  it("imports organizations from --urls and prints result", async () => {
    vi.mocked(importOrganizationsFromUrls).mockResolvedValue(MOCK_RESULT);

    await handleImportOrganizationsFromUrls(4, {
      urls: "https://linkedin.com/company/acme,https://linkedin.com/company/globex",
    });

    expect(process.exitCode).toBeUndefined();
    const output = getStdout(stdoutSpy);
    expect(output).toContain(
      "Imported 3 organizations into campaign 4 action 20.",
    );
    expect(output).toContain("1 already in queue.");
  });

  it("imports from --urls-file", async () => {
    vi.mocked(readFileSync).mockReturnValue(
      "https://linkedin.com/company/acme\nhttps://linkedin.com/company/globex",
    );
    vi.mocked(importOrganizationsFromUrls).mockResolvedValue(MOCK_RESULT);

    await handleImportOrganizationsFromUrls(4, { urlsFile: "urls.txt" });

    expect(process.exitCode).toBeUndefined();
    expect(getStdout(stdoutSpy)).toContain("Imported 3 organizations");
  });

  it("prints JSON with --json", async () => {
    vi.mocked(importOrganizationsFromUrls).mockResolvedValue(MOCK_RESULT);

    await handleImportOrganizationsFromUrls(4, {
      urls: "https://linkedin.com/company/acme",
      json: true,
    });

    expect(process.exitCode).toBeUndefined();
    const parsed = JSON.parse(getStdout(stdoutSpy));
    expect(parsed.success).toBe(true);
    expect(parsed.campaignId).toBe(4);
    expect(parsed.actionId).toBe(20);
    expect(parsed.imported).toBe(3);
    expect(parsed.inExcludeList).toBe(0);
  });

  it("shows exclude-list and failed counts when non-zero", async () => {
    vi.mocked(importOrganizationsFromUrls).mockResolvedValue({
      ...MOCK_RESULT,
      imported: 1,
      alreadyInQueue: 0,
      alreadyProcessed: 2,
      inExcludeList: 3,
      failed: 1,
    });

    await handleImportOrganizationsFromUrls(4, {
      urls: "https://linkedin.com/company/acme",
    });

    const output = getStdout(stdoutSpy);
    expect(output).toContain("2 already processed.");
    expect(output).toContain("3 in exclude list.");
    expect(output).toContain("1 failed.");
  });

  it("sets exitCode 1 when both url options provided", async () => {
    await handleImportOrganizationsFromUrls(4, {
      urls: "https://linkedin.com/company/acme",
      urlsFile: "urls.txt",
    });

    expect(process.exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      "Use only one of --urls or --urls-file.\n",
    );
  });

  it("sets exitCode 1 when no url option provided", async () => {
    await handleImportOrganizationsFromUrls(4, {});

    expect(process.exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      "Either --urls or --urls-file is required.\n",
    );
  });

  it("sets exitCode 1 when URLs are empty", async () => {
    vi.mocked(readFileSync).mockReturnValue("");

    await handleImportOrganizationsFromUrls(4, { urlsFile: "empty.txt" });

    expect(process.exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith("No URLs provided.\n");
  });

  it("sets exitCode 1 when campaign not found", async () => {
    vi.mocked(importOrganizationsFromUrls).mockRejectedValue(
      new CampaignNotFoundError(999),
    );

    await handleImportOrganizationsFromUrls(999, {
      urls: "https://linkedin.com/company/acme",
    });

    expect(process.exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith("Campaign 999 not found.\n");
  });

  it("sets exitCode 1 on CampaignExecutionError (e.g. people campaign)", async () => {
    vi.mocked(importOrganizationsFromUrls).mockRejectedValue(
      new CampaignExecutionError(
        "Campaign 1 is a people campaign — importOrganizationsFromUrls requires an organizations campaign (campaigns.type = 2).",
      ),
    );

    await handleImportOrganizationsFromUrls(1, {
      urls: "https://linkedin.com/company/acme",
    });

    expect(process.exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to import organizations:"),
    );
  });

  it("sets exitCode 1 on InstanceNotRunningError", async () => {
    vi.mocked(importOrganizationsFromUrls).mockRejectedValue(
      new InstanceNotRunningError("No LinkedHelper instance is running."),
    );

    await handleImportOrganizationsFromUrls(4, {
      urls: "https://linkedin.com/company/acme",
    });

    expect(process.exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      "No LinkedHelper instance is running.\n",
    );
  });

  it("forwards accountId to importOrganizationsFromUrls", async () => {
    vi.mocked(importOrganizationsFromUrls).mockResolvedValue(MOCK_RESULT);

    await handleImportOrganizationsFromUrls(4, {
      urls: "https://linkedin.com/company/acme",
      accountId: 7,
    });

    expect(importOrganizationsFromUrls).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 7 }),
    );
  });
});
