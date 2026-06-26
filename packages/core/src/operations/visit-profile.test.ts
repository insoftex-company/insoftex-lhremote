// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/account-resolution.js", () => ({
  resolveAccount: vi.fn(),
}));

vi.mock("../services/instance-context.js", () => ({
  withInstanceDatabase: vi.fn(),
}));

vi.mock("../db/index.js", () => ({
  ProfileRepository: vi.fn(),
}));

vi.mock("../services/ephemeral-campaign.js", () => ({
  EphemeralCampaignService: vi.fn(),
}));

vi.mock("./wait-for-logged-in-state.js", () => ({
  gateOnLoggedInState: vi.fn().mockResolvedValue(undefined),
  waitForLoggedInState: vi.fn().mockResolvedValue(undefined),
  LoggedInStateTimeoutError: class extends Error {},
}));

import { waitForLoggedInState } from "./wait-for-logged-in-state.js";

import type { InstanceDatabaseContext } from "../services/instance-context.js";
import { resolveAccount } from "../services/account-resolution.js";
import { withInstanceDatabase } from "../services/instance-context.js";
import { ProfileRepository } from "../db/index.js";
import { EphemeralCampaignService } from "../services/ephemeral-campaign.js";
import { CampaignExecutionError } from "../services/errors.js";
import { visitProfile } from "./visit-profile.js";

const MOCK_PROFILE = {
  id: 100,
  miniProfile: {
    firstName: "Jane",
    lastName: "Doe",
    headline: "Software Engineer",
    avatar: null,
  },
  externalIds: [{ externalId: "jane-doe-123", typeGroup: "public", isMemberId: false }],
  currentPosition: { company: "Acme Corp", title: "Senior Engineer" },
  positions: [
    {
      company: "Acme Corp",
      title: "Senior Engineer",
      startDate: "2023-01",
      endDate: null,
      isCurrent: true,
    },
  ],
  education: [],
  skills: [{ name: "TypeScript" }],
  emails: [],
};

const mockExecute = vi.fn();
const mockInstance = {};

function setupMocks() {
  vi.mocked(resolveAccount).mockResolvedValue(1);

  vi.mocked(withInstanceDatabase).mockImplementation(
    async (_cdpPort, _accountId, callback) =>
      callback({
        accountId: 1,
        instance: mockInstance,
        db: {},
      } as unknown as InstanceDatabaseContext),
  );

  vi.mocked(ProfileRepository).mockImplementation(function () {
    return {
      findById: vi.fn().mockReturnValue(MOCK_PROFILE),
    } as unknown as ProfileRepository;
  });

  vi.mocked(EphemeralCampaignService).mockImplementation(function () {
    return { execute: mockExecute } as unknown as EphemeralCampaignService;
  });
}

describe("visitProfile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockResolvedValue({ success: true, personId: 100, results: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws when neither personId nor url is provided", async () => {
    await expect(
      visitProfile({ cdpPort: 9222 }),
    ).rejects.toThrow("Exactly one of personId or url must be provided");
  });

  it("throws when both personId and url are provided", async () => {
    await expect(
      visitProfile({ personId: 100, url: "https://www.linkedin.com/in/jane-doe-123", cdpPort: 9222 }),
    ).rejects.toThrow("Exactly one of personId or url must be provided");
  });

  it("returns success with profile after visiting by personId", async () => {
    setupMocks();

    const result = await visitProfile({ personId: 100, cdpPort: 9222 });

    expect(result.success).toBe(true);
    expect(vi.mocked(waitForLoggedInState)).toHaveBeenCalled();
    expect(result.actionType).toBe("VisitAndExtract");
    expect(result.profile).toBe(MOCK_PROFILE);
  });

  it("calls EphemeralCampaignService.execute with VisitAndExtract and personId", async () => {
    setupMocks();

    await visitProfile({ personId: 100, cdpPort: 9222 });

    expect(mockExecute).toHaveBeenCalledWith("VisitAndExtract", 100, undefined, {});
  });

  it("calls EphemeralCampaignService.execute with URL when url is provided", async () => {
    setupMocks();

    await visitProfile({
      url: "https://www.linkedin.com/in/jane-doe-123",
      cdpPort: 9222,
    });

    expect(mockExecute).toHaveBeenCalledWith(
      "VisitAndExtract",
      "https://www.linkedin.com/in/jane-doe-123",
      undefined,
      {},
    );
  });

  it("handles URL with trailing slash and query params", async () => {
    setupMocks();

    await visitProfile({
      url: "https://www.linkedin.com/in/jane-doe-123/?locale=en_US",
      cdpPort: 9222,
    });

    expect(mockExecute).toHaveBeenCalledWith(
      "VisitAndExtract",
      "https://www.linkedin.com/in/jane-doe-123/?locale=en_US",
      undefined,
      {},
    );
  });

  it("passes extractCurrentOrganizations when provided", async () => {
    setupMocks();

    await visitProfile({ personId: 100, cdpPort: 9222, extractCurrentOrganizations: true });

    expect(mockExecute).toHaveBeenCalledWith(
      "VisitAndExtract",
      100,
      { extractCurrentOrganizations: true },
      {},
    );
  });

  it("omits extractCurrentOrganizations when undefined", async () => {
    setupMocks();

    await visitProfile({ personId: 100, cdpPort: 9222 });

    expect(mockExecute).toHaveBeenCalledWith("VisitAndExtract", 100, undefined, {});
  });

  it("throws CampaignExecutionError when ephemeral action result is failure", async () => {
    setupMocks();
    mockExecute.mockResolvedValue({ success: false, personId: 100, results: [] });

    await expect(
      visitProfile({ personId: 100, cdpPort: 9222 }),
    ).rejects.toThrow(CampaignExecutionError);

    await expect(
      visitProfile({ personId: 100, cdpPort: 9222 }),
    ).rejects.toThrow("VisitAndExtract action did not complete successfully for person 100");
  });

  it("passes keepCampaign through to ephemeral.execute", async () => {
    setupMocks();

    await visitProfile({ personId: 100, cdpPort: 9222, keepCampaign: true });

    expect(mockExecute).toHaveBeenCalledWith(
      "VisitAndExtract",
      100,
      undefined,
      { keepCampaign: true },
    );
  });

  it("passes timeout through to ephemeral.execute", async () => {
    setupMocks();

    await visitProfile({ personId: 100, cdpPort: 9222, timeout: 60_000 });

    expect(mockExecute).toHaveBeenCalledWith(
      "VisitAndExtract",
      100,
      undefined,
      { timeout: 60_000 },
    );
  });

  it("queries profile with includePositions true using personId from execute result", async () => {
    setupMocks();

    await visitProfile({ personId: 100, cdpPort: 9222 });

    const mockRepo = vi.mocked(ProfileRepository).mock.results[0]
      ?.value as { findById: ReturnType<typeof vi.fn> };
    expect(mockRepo.findById).toHaveBeenCalledWith(100, { includePositions: true });
  });

  it("uses personId from execute result when URL target resolves a different ID", async () => {
    setupMocks();
    mockExecute.mockResolvedValue({ success: true, personId: 42, results: [] });

    await visitProfile({
      url: "https://www.linkedin.com/in/jane-doe-123",
      cdpPort: 9222,
    });

    const mockRepo = vi.mocked(ProfileRepository).mock.results[0]
      ?.value as { findById: ReturnType<typeof vi.fn> };
    expect(mockRepo.findById).toHaveBeenCalledWith(42, { includePositions: true });
  });

  it("passes instanceTimeout and db readOnly false to withInstanceDatabase", async () => {
    setupMocks();

    await visitProfile({ personId: 100, cdpPort: 9222 });

    expect(withInstanceDatabase).toHaveBeenCalledWith(
      9222,
      1,
      expect.any(Function),
      { instanceTimeout: 120_000, db: { readOnly: false } },
    );
  });

  it("passes connection options to resolveAccount", async () => {
    setupMocks();

    await visitProfile({
      personId: 100,
      cdpPort: 1234,
      cdpHost: "192.168.1.1",
      allowRemote: true,
    });

    expect(resolveAccount).toHaveBeenCalledWith(1234, {
      host: "192.168.1.1",
      allowRemote: true,
    });
  });

  it("omits undefined connection options", async () => {
    setupMocks();

    await visitProfile({ personId: 100, cdpPort: 9222 });

    expect(resolveAccount).toHaveBeenCalledWith(9222, {});
  });

  it("propagates resolveAccount errors", async () => {
    vi.mocked(resolveAccount).mockRejectedValue(new Error("connection refused"));

    await expect(
      visitProfile({ personId: 100, cdpPort: 9222 }),
    ).rejects.toThrow("connection refused");
  });

  it("propagates withInstanceDatabase errors", async () => {
    vi.mocked(resolveAccount).mockResolvedValue(1);
    vi.mocked(withInstanceDatabase).mockRejectedValue(new Error("instance not running"));

    await expect(
      visitProfile({ personId: 100, cdpPort: 9222 }),
    ).rejects.toThrow("instance not running");
  });

  it("propagates EphemeralCampaignService.execute errors", async () => {
    vi.mocked(resolveAccount).mockResolvedValue(1);
    vi.mocked(withInstanceDatabase).mockImplementation(
      async (_cdpPort, _accountId, callback) =>
        callback({
          accountId: 1,
          instance: mockInstance,
          db: {},
        } as unknown as InstanceDatabaseContext),
    );
    vi.mocked(ProfileRepository).mockImplementation(function () {
      return { findById: vi.fn() } as unknown as ProfileRepository;
    });
    vi.mocked(EphemeralCampaignService).mockImplementation(function () {
      return {
        execute: vi.fn().mockRejectedValue(new Error("VisitAndExtract failed")),
      } as unknown as EphemeralCampaignService;
    });

    await expect(
      visitProfile({ personId: 100, cdpPort: 9222 }),
    ).rejects.toThrow("VisitAndExtract failed");
  });

  it("propagates ProfileRepository.findById errors", async () => {
    vi.mocked(resolveAccount).mockResolvedValue(1);
    vi.mocked(withInstanceDatabase).mockImplementation(
      async (_cdpPort, _accountId, callback) =>
        callback({
          accountId: 1,
          instance: mockInstance,
          db: {},
        } as unknown as InstanceDatabaseContext),
    );
    vi.mocked(ProfileRepository).mockImplementation(function () {
      return {
        findById: vi.fn().mockImplementation(() => {
          throw new Error("profile not found");
        }),
      } as unknown as ProfileRepository;
    });
    vi.mocked(EphemeralCampaignService).mockImplementation(function () {
      return { execute: mockExecute } as unknown as EphemeralCampaignService;
    });

    await expect(
      visitProfile({ personId: 100, cdpPort: 9222 }),
    ).rejects.toThrow("profile not found");
  });
});
