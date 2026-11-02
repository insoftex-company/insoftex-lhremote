// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@insoftex/lhremote-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@insoftex/lhremote-core")>();
  return {
    ...actual,
    LauncherService: vi.fn(),
    resolveAppPort: vi.fn(),
    startInstanceWithRecovery: vi.fn(),
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
  startInstanceWithRecovery,
  withLauncherQueue,
} from "@insoftex/lhremote-core";

import { handleStartInstance } from "./start-instance.js";
import { mockLauncher } from "./testing/mock-helpers.js";

describe("handleStartInstance", () => {
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

  it("prints success with port on successful start", async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockReturnValue(true);

    mockLauncher();
    vi.mocked(startInstanceWithRecovery).mockResolvedValue({
      status: "started",
      port: 55123,
    });

    await handleStartInstance("42", {});

    expect(stdoutSpy).toHaveBeenCalledWith(
      "Instance started for account 42 on CDP port 55123\n",
    );
    expect(withLauncherQueue).toHaveBeenCalledWith(
      expect.any(Function),
      { type: "start", accountId: 42, launcherPort: 9222 },
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

    await handleStartInstance("42", {});

    expect(process.exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("not running"),
    );
  });

  it("handles idempotent 'already running' when port available", async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockReturnValue(true);

    mockLauncher();
    vi.mocked(startInstanceWithRecovery).mockResolvedValue({
      status: "already_running",
      port: 55123,
    });

    await handleStartInstance("42", {});

    expect(stdoutSpy).toHaveBeenCalledWith(
      "Instance already running for account 42 on CDP port 55123\n",
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("sets exitCode 1 on unexpected error", async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockReturnValue(true);

    mockLauncher();
    vi.mocked(startInstanceWithRecovery).mockRejectedValue(
      new Error("unexpected failure"),
    );

    await handleStartInstance("42", {});

    expect(process.exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("unexpected failure"),
    );
  });

  it("passes cdpPort option to LauncherService", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);

    mockLauncher();
    vi.mocked(startInstanceWithRecovery).mockResolvedValue({
      status: "started",
      port: 55123,
    });

    await handleStartInstance("42", { cdpPort: 4567 });

    expect(LauncherService).toHaveBeenCalledWith(4567, {});
  });

  it("sets exitCode 1 when instance fails to initialize within timeout", async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockReturnValue(true);

    mockLauncher();
    vi.mocked(startInstanceWithRecovery).mockResolvedValue({
      status: "timeout",
    });

    await handleStartInstance("42", {});

    expect(process.exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      "Instance started but failed to initialize within timeout.\n",
    );
  });

  it("auto-selects a single account when no account ID is supplied", async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockReturnValue(true);

    mockLauncher({
      listAccounts: vi.fn().mockResolvedValue([{ id: 77 }]),
    });
    vi.mocked(startInstanceWithRecovery).mockResolvedValue({
      status: "started",
      port: 55123,
    });

    await handleStartInstance(undefined, {});

    expect(stdoutSpy).toHaveBeenCalledWith(
      "Instance started for account 77 on CDP port 55123\n",
    );
  });

  it("requires an explicit account ID when multiple accounts exist", async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockReturnValue(true);

    mockLauncher({
      listAccounts: vi.fn().mockResolvedValue([{ id: 77 }, { id: 88 }]),
    });

    await handleStartInstance(undefined, {});

    expect(process.exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      "Multiple accounts found. Specify accountId. Use list-accounts to see available accounts.\n",
    );
  });
});
