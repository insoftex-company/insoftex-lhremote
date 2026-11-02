// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@insoftex/lhremote-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@insoftex/lhremote-core")>();
  return {
    ...actual,
    LauncherService: vi.fn(),
    resolveAppPort: vi.fn(),
    waitForInstanceShutdown: vi.fn(),
    withLauncherQueue: vi.fn(async (op: () => Promise<unknown>) => op()),
    withLauncherRecovery: vi.fn(async (_launcher: unknown, op: () => Promise<unknown>) => ({
      result: await op(),
      launcherRecovered: false,
    })),
  };
});

import {
  LauncherService,
  LinkedHelperNotRunningError,
  resolveAppPort,
  waitForInstanceShutdown,
  withLauncherQueue,
} from "@insoftex/lhremote-core";

import { handleStopInstance } from "./stop-instance.js";
import { mockLauncher } from "./testing/mock-helpers.js";

describe("handleStopInstance", () => {
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    process.exitCode = undefined;
    vi.clearAllMocks();
    vi.mocked(resolveAppPort).mockResolvedValue(9222);
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it("prints success on successful stop", async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockReturnValue(true);

    mockLauncher({ stopInstance: vi.fn().mockResolvedValue(undefined) });

    await handleStopInstance("42", {});

    expect(stdoutSpy).toHaveBeenCalledWith(
      "Instance stopped for account 42\n",
    );
    expect(waitForInstanceShutdown).toHaveBeenCalledWith(9222);
    expect(withLauncherQueue).toHaveBeenCalledWith(
      expect.any(Function),
      { type: "stop", launcherPort: 9222 },
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("sets exitCode 1 on connection error", async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockReturnValue(true);

    mockLauncher({
      connect: vi
        .fn()
        .mockRejectedValue(new LinkedHelperNotRunningError(9222)),
    });

    await handleStopInstance("42", {});

    expect(process.exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("not running"),
    );
  });

  it("sets exitCode 1 on unexpected error", async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockReturnValue(true);

    mockLauncher({
      stopInstance: vi
        .fn()
        .mockRejectedValue(new Error("unexpected failure")),
    });

    await handleStopInstance("42", {});

    expect(process.exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith("unexpected failure\n");
  });

  it("passes cdpPort option to LauncherService", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);

    mockLauncher({ stopInstance: vi.fn().mockResolvedValue(undefined) });

    await handleStopInstance("42", { cdpPort: 4567 });

    expect(LauncherService).toHaveBeenCalledWith(4567, {});
  });

  it("auto-selects a single account when no account ID is supplied", async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockReturnValue(true);

    mockLauncher({
      listAccounts: vi.fn().mockResolvedValue([{ id: 77 }]),
      stopInstance: vi.fn().mockResolvedValue(undefined),
    });

    await handleStopInstance(undefined, {});

    expect(stdoutSpy).toHaveBeenCalledWith(
      "Instance stopped for account 77\n",
    );
  });

  it("requires an explicit account ID when multiple accounts exist", async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockReturnValue(true);

    mockLauncher({
      listAccounts: vi.fn().mockResolvedValue([{ id: 77 }, { id: 88 }]),
    });

    await handleStopInstance(undefined, {});

    expect(process.exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      "Multiple accounts found. Specify accountId. Use list-accounts to see available accounts.\n",
    );
  });
});
