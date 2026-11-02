// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@insoftex/lhremote-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@insoftex/lhremote-core")>();
  return {
    ...actual,
    campaignListPeople: vi.fn(),
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
  type CampaignListPeopleOutput,
  ActionNotFoundError,
  CampaignNotFoundError,
  campaignListPeople,
} from "@insoftex/lhremote-core";
import { readFileSync } from "node:fs";

import { handleCampaignListPeople } from "./campaign-list-people.js";
import { getStdout } from "./testing/mock-helpers.js";

const MOCK_RESULT: CampaignListPeopleOutput = {
  campaignId: 1,
  people: [
    {
      personId: 100,
      firstName: "Alice",
      lastName: "Smith",
      publicId: "alice-smith",
      status: "queued",
      currentActionId: 1,
    },
    {
      personId: 200,
      firstName: "Bob",
      lastName: null,
      publicId: null,
      status: "successful",
      currentActionId: 2,
    },
  ],
  total: 2,
  limit: 20,
  offset: 0,
};

describe("handleCampaignListPeople", () => {
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

  it("prints human-readable people list", async () => {
    vi.mocked(campaignListPeople).mockResolvedValue(MOCK_RESULT);

    await handleCampaignListPeople(1, {});

    expect(process.exitCode).toBeUndefined();
    const output = getStdout(stdoutSpy);
    expect(output).toContain("Campaign #1 People (2 total)");
    expect(output).toContain("#100 Alice Smith (alice-smith)");
    expect(output).toContain("queued at action #1");
    expect(output).toContain("#200 Bob");
    expect(output).toContain("successful at action #2");
  });

  it("prints JSON with --json", async () => {
    vi.mocked(campaignListPeople).mockResolvedValue(MOCK_RESULT);

    await handleCampaignListPeople(1, { json: true });

    expect(process.exitCode).toBeUndefined();
    const parsed = JSON.parse(getStdout(stdoutSpy));
    expect(parsed.campaignId).toBe(1);
    expect(parsed.people).toHaveLength(2);
    expect(parsed.total).toBe(2);
  });

  it("prints empty message when no people found", async () => {
    vi.mocked(campaignListPeople).mockResolvedValue({
      ...MOCK_RESULT,
      people: [],
      total: 0,
    });

    await handleCampaignListPeople(1, {});

    const output = getStdout(stdoutSpy);
    expect(output).toContain("No people found.");
  });

  it("shows pagination hint when more results available", async () => {
    vi.mocked(campaignListPeople).mockResolvedValue({
      ...MOCK_RESULT,
      total: 50,
      limit: 20,
      offset: 0,
    });

    await handleCampaignListPeople(1, {});

    const output = getStdout(stdoutSpy);
    expect(output).toContain("Showing 1-2 of 50");
    expect(output).toContain("--offset");
    expect(output).toContain("--limit");
  });

  it("does not show pagination hint when all results shown", async () => {
    vi.mocked(campaignListPeople).mockResolvedValue(MOCK_RESULT);

    await handleCampaignListPeople(1, {});

    const output = getStdout(stdoutSpy);
    expect(output).not.toContain("Showing");
  });

  it("passes actionId, status, limit, and offset options", async () => {
    vi.mocked(campaignListPeople).mockResolvedValue(MOCK_RESULT);

    await handleCampaignListPeople(1, {
      actionId: 5,
      status: "queued",
      limit: 10,
      offset: 20,
    });

    expect(campaignListPeople).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignId: 1,
        actionId: 5,
        status: "queued",
        limit: 10,
        offset: 20,
      }),
    );
  });

  it("sets exitCode 1 when campaign not found", async () => {
    vi.mocked(campaignListPeople).mockRejectedValue(
      new CampaignNotFoundError(999),
    );

    await handleCampaignListPeople(999, {});

    expect(process.exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith("Campaign 999 not found.\n");
  });

  it("sets exitCode 1 when action not found", async () => {
    vi.mocked(campaignListPeople).mockRejectedValue(
      new ActionNotFoundError(99, 1),
    );

    await handleCampaignListPeople(1, { actionId: 99 });

    expect(process.exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      "Action 99 not found in campaign 1.\n",
    );
  });

  it("sets exitCode 1 when resolveAccount fails", async () => {
    vi.mocked(campaignListPeople).mockRejectedValue(new Error("timeout"));

    await handleCampaignListPeople(1, {});

    expect(process.exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith("timeout\n");
  });

  describe("--urls / --urls-file", () => {
    it("parses --urls into linkedInUrls", async () => {
      vi.mocked(campaignListPeople).mockResolvedValue(MOCK_RESULT);

      await handleCampaignListPeople(1, {
        urls: "https://www.linkedin.com/in/alice-smith/, https://www.linkedin.com/in/carol-jones/",
      });

      expect(campaignListPeople).toHaveBeenCalledWith(
        expect.objectContaining({
          linkedInUrls: [
            "https://www.linkedin.com/in/alice-smith/",
            "https://www.linkedin.com/in/carol-jones/",
          ],
        }),
      );
    });

    it("reads --urls-file into linkedInUrls", async () => {
      vi.mocked(campaignListPeople).mockResolvedValue(MOCK_RESULT);
      vi.mocked(readFileSync).mockReturnValue(
        "https://www.linkedin.com/in/alice-smith/\nhttps://www.linkedin.com/in/carol-jones/\n",
      );

      await handleCampaignListPeople(1, { urlsFile: "urls.txt" });

      expect(campaignListPeople).toHaveBeenCalledWith(
        expect.objectContaining({
          linkedInUrls: [
            "https://www.linkedin.com/in/alice-smith/",
            "https://www.linkedin.com/in/carol-jones/",
          ],
        }),
      );
    });

    it("sets exitCode 1 when both --urls and --urls-file are given", async () => {
      await handleCampaignListPeople(1, {
        urls: "https://www.linkedin.com/in/alice-smith/",
        urlsFile: "urls.txt",
      });

      expect(process.exitCode).toBe(1);
      expect(campaignListPeople).not.toHaveBeenCalled();
      expect(stderrSpy).toHaveBeenCalledWith("Use only one of --urls or --urls-file.\n");
    });

    it("sets exitCode 1 when urls-file read fails", async () => {
      vi.mocked(readFileSync).mockImplementation(() => {
        throw new Error("ENOENT: no such file");
      });

      await handleCampaignListPeople(1, { urlsFile: "missing.txt" });

      expect(process.exitCode).toBe(1);
      expect(campaignListPeople).not.toHaveBeenCalled();
    });

    it("prints notFoundLinkedInUrls when present", async () => {
      vi.mocked(campaignListPeople).mockResolvedValue({
        ...MOCK_RESULT,
        notFoundLinkedInUrls: ["https://www.linkedin.com/in/nobody-here/"],
      });

      await handleCampaignListPeople(1, {
        urls: "https://www.linkedin.com/in/nobody-here/",
      });

      const output = getStdout(stdoutSpy);
      expect(output).toContain("1 of the given URLs are not on the target list");
      expect(output).toContain("https://www.linkedin.com/in/nobody-here/");
    });

    it("omits the not-found section when notFoundLinkedInUrls is absent", async () => {
      vi.mocked(campaignListPeople).mockResolvedValue(MOCK_RESULT);

      await handleCampaignListPeople(1, {});

      const output = getStdout(stdoutSpy);
      expect(output).not.toContain("not on the target list");
    });
  });
});
