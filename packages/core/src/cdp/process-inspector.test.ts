// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module-level mocks — must be hoisted before any imports from the module
// ---------------------------------------------------------------------------

vi.mock("ps-list", () => ({
  default: vi.fn().mockResolvedValue([]),
}));

vi.mock("pid-port", () => ({
  pidToPorts: vi.fn().mockResolvedValue(new Set<number>()),
}));

vi.mock("../utils/cdp-port.js", () => ({
  isCdpPort: vi.fn().mockResolvedValue(false),
}));

// Ensure the WMI path is not triggered (we're on non-Windows in tests)
// No explicit mock needed: process.platform is "darwin"/"linux" in CI

import psList from "ps-list";
import { pidToPorts } from "pid-port";
import { isCdpPort } from "../utils/cdp-port.js";
import { reapOrphans, scanOrphans, scanRunningInstances } from "./process-inspector.js";
import type { OrphanProcess } from "./process-inspector.js";

const mockedPsList = vi.mocked(psList);
// pidToPorts has two overloads; cast to the single-PID variant used by process-inspector
const mockedPidToPorts = vi.mocked(pidToPorts as (pid: number) => Promise<Set<number>>);
const mockedIsCdpPort = vi.mocked(isCdpPort);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a typical account-instance main process command line. */
function instanceCmdline(opts: {
  appId?: number;
  userLiId?: number;
  fullName?: string;
  email?: string;
  lhAccountEmail?: string; // The decoy --lh-account field
}): string {
  const id = opts.appId ?? 347559;
  const userLi = JSON.stringify({
    id,
    fullName: opts.fullName ?? "Test User",
    email: opts.email ?? "test@example.com",
    avatar: "https://example.com/avatar.jpg",
  });
  // Decoy --lh-account (license owner, same for all instances)
  const lhAccount = JSON.stringify({
    email: opts.lhAccountEmail ?? "license-owner@example.com",
    fullName: "License Owner",
  });
  return (
    `C:\\Users\\test\\AppData\\Local\\Programs\\linked-helper\\app-2.113.101\\resources\\out\\linked-helper.exe` +
    ` --args --env=PROD` +
    ` --app-id=${String(id)}` +
    ` --user-li-id=${String(opts.userLiId ?? id)}` +
    ` --user-li=${userLi}` +
    ` --lh-account=${lhAccount}` +
    ` --app-credentials=REDACTED_SECRET` +
    ` --upstream-proxy=socks5://user:password@proxy.example.com` +
    ` --sentry=https://key@sentry.io/123`
  );
}

/** Build a Chromium helper child process command line. */
function helperCmdline(type: string): string {
  return (
    `C:\\Users\\test\\AppData\\Local\\Programs\\linked-helper\\app-2.113.101\\linked-helper.exe` +
    ` --type=${type} --renderer-client-id=2`
  );
}

/** Build a launcher command line. */
function launcherCmdline(): string {
  return (
    `C:\\Users\\test\\AppData\\Local\\Programs\\linked-helper\\app-2.113.101\\linked-helper.exe` +
    ` --remote-debugging-port=9222`
  );
}

// ---------------------------------------------------------------------------
// Role classification
// ---------------------------------------------------------------------------

describe("role classification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPidToPorts.mockResolvedValue(new Set());
    mockedIsCdpPort.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("classifies instance main process correctly", async () => {
    mockedPsList.mockResolvedValue([
      { pid: 13004, ppid: 9000, name: "linked-helper.exe", cmd: instanceCmdline({}) },
    ] as never);

    const instances = await scanRunningInstances();
    expect(instances).toHaveLength(1);
    expect(instances[0]?.pid).toBe(13004);
  });

  it("does NOT include helper children in runningInstances", async () => {
    mockedPsList.mockResolvedValue([
      { pid: 1000, ppid: 0, name: "linked-helper.exe", cmd: launcherCmdline() },
      { pid: 13004, ppid: 1000, name: "linked-helper.exe", cmd: instanceCmdline({}) },
      { pid: 8008, ppid: 13004, name: "linked-helper.exe", cmd: helperCmdline("utility") },
      { pid: 8009, ppid: 13004, name: "linked-helper.exe", cmd: helperCmdline("gpu-process") },
      { pid: 8010, ppid: 1000, name: "linked-helper.exe", cmd: helperCmdline("crashpad-handler") },
    ] as never);

    const instances = await scanRunningInstances();
    // Only the instance main process (pid 13004) should appear
    expect(instances).toHaveLength(1);
    expect(instances[0]?.pid).toBe(13004);
    expect(instances.every((i) => i.pid !== 8008 && i.pid !== 8009 && i.pid !== 8010)).toBe(true);
  });

  it("counts helper children per instance", async () => {
    mockedPsList.mockResolvedValue([
      { pid: 13004, ppid: 0, name: "linked-helper.exe", cmd: instanceCmdline({ appId: 347559 }) },
      { pid: 8008, ppid: 13004, name: "linked-helper.exe", cmd: helperCmdline("utility") },
      { pid: 8009, ppid: 13004, name: "linked-helper.exe", cmd: helperCmdline("gpu-process") },
      { pid: 8010, ppid: 13004, name: "linked-helper.exe", cmd: helperCmdline("renderer") },
    ] as never);

    const instances = await scanRunningInstances();
    expect(instances).toHaveLength(1);
    expect(instances[0]?.helperChildCount).toBe(3);
  });

  it("handles multiple instances without interference", async () => {
    mockedPsList.mockResolvedValue([
      { pid: 13004, ppid: 0, name: "linked-helper.exe", cmd: instanceCmdline({ appId: 347559 }) },
      { pid: 13640, ppid: 0, name: "linked-helper.exe", cmd: instanceCmdline({ appId: 329925, fullName: "Mike Florko", email: "mike@example.com" }) },
      { pid: 7044, ppid: 0, name: "linked-helper.exe", cmd: instanceCmdline({ appId: 331874, fullName: "Michael Fliorko", email: "michael@example.com" }) },
    ] as never);

    const instances = await scanRunningInstances();
    expect(instances).toHaveLength(3);
    const ids = instances.map((i) => i.accountId).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(ids).toEqual([329925, 331874, 347559]);
  });
});

// ---------------------------------------------------------------------------
// Identity parsing
// ---------------------------------------------------------------------------

describe("identity parsing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPidToPorts.mockResolvedValue(new Set());
    mockedIsCdpPort.mockResolvedValue(false);
  });

  it("extracts accountId from --app-id", async () => {
    mockedPsList.mockResolvedValue([
      { pid: 13004, ppid: 0, name: "linked-helper.exe", cmd: instanceCmdline({ appId: 347559 }) },
    ] as never);

    const [inst] = await scanRunningInstances();
    expect(inst?.accountId).toBe(347559);
    expect(inst?.confidence).toBe("high");
    expect(inst?.source).toBe("cmdline");
  });

  it("extracts name and email from --user-li JSON", async () => {
    mockedPsList.mockResolvedValue([
      { pid: 13004, ppid: 0, name: "linked-helper.exe", cmd: instanceCmdline({ appId: 347559, fullName: "Vira Lyn", email: "vira@example.com" }) },
    ] as never);

    const [inst] = await scanRunningInstances();
    expect(inst?.name).toBe("Vira Lyn");
    expect(inst?.email).toBe("vira@example.com");
  });

  it("three instances with identical --lh-account resolve to three DISTINCT accounts (decoy regression)", async () => {
    // All three have the same --lh-account (license owner) but different --app-id / --user-li
    const sharedLhAccountEmail = "license-owner@example.com";
    mockedPsList.mockResolvedValue([
      { pid: 13004, ppid: 0, name: "linked-helper.exe", cmd: instanceCmdline({ appId: 347559, fullName: "Vira Lyn", email: "vira@example.com", lhAccountEmail: sharedLhAccountEmail }) },
      { pid: 13640, ppid: 0, name: "linked-helper.exe", cmd: instanceCmdline({ appId: 329925, fullName: "Mike Florko", email: "mike@example.com", lhAccountEmail: sharedLhAccountEmail }) },
      { pid: 7044, ppid: 0, name: "linked-helper.exe", cmd: instanceCmdline({ appId: 331874, fullName: "Michael Fliorko", email: "michael@example.com", lhAccountEmail: sharedLhAccountEmail }) },
    ] as never);

    const instances = await scanRunningInstances();
    expect(instances).toHaveLength(3);

    const accountIds = new Set(instances.map((i) => i.accountId));
    expect(accountIds.size).toBe(3);
    expect(accountIds.has(347559)).toBe(true);
    expect(accountIds.has(329925)).toBe(true);
    expect(accountIds.has(331874)).toBe(true);

    // Verify names are distinct (not all "License Owner" from --lh-account)
    const names = instances.map((i) => i.name);
    expect(names).not.toContain("License Owner");
    expect(names).toContain("Vira Lyn");
    expect(names).toContain("Mike Florko");
    expect(names).toContain("Michael Fliorko");
  });

  it("sets confidence=unknown when no identity fields are present", async () => {
    // A process under resources/out/ but no --app-id or --user-li
    const bareCmd =
      "C:\\path\\resources\\out\\linked-helper.exe --env=PROD";
    mockedPsList.mockResolvedValue([
      { pid: 99, ppid: 0, name: "linked-helper.exe", cmd: bareCmd },
    ] as never);

    const instances = await scanRunningInstances();
    expect(instances[0]?.accountId).toBeNull();
    expect(instances[0]?.confidence).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// Secret redaction: tool output must never contain secrets
// ---------------------------------------------------------------------------

describe("secret redaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPidToPorts.mockResolvedValue(new Set());
    mockedIsCdpPort.mockResolvedValue(false);
  });

  it("never exposes --app-credentials in output", async () => {
    mockedPsList.mockResolvedValue([
      { pid: 13004, ppid: 0, name: "linked-helper.exe", cmd: instanceCmdline({ appId: 347559 }) },
    ] as never);

    const instances = await scanRunningInstances();
    const serialized = JSON.stringify(instances);
    expect(serialized).not.toContain("REDACTED_SECRET");
    expect(serialized).not.toContain("app-credentials");
  });

  it("never exposes --upstream-proxy credentials in output", async () => {
    mockedPsList.mockResolvedValue([
      { pid: 13004, ppid: 0, name: "linked-helper.exe", cmd: instanceCmdline({ appId: 347559 }) },
    ] as never);

    const instances = await scanRunningInstances();
    const serialized = JSON.stringify(instances);
    expect(serialized).not.toContain("socks5://");
    expect(serialized).not.toContain("upstream-proxy");
  });

  it("never exposes Sentry DSN in output", async () => {
    mockedPsList.mockResolvedValue([
      { pid: 13004, ppid: 0, name: "linked-helper.exe", cmd: instanceCmdline({ appId: 347559 }) },
    ] as never);

    const instances = await scanRunningInstances();
    const serialized = JSON.stringify(instances);
    expect(serialized).not.toContain("sentry.io");
    expect(serialized).not.toContain("--sentry");
  });

  it("never exposes raw --lh-account license data in output", async () => {
    mockedPsList.mockResolvedValue([
      { pid: 13004, ppid: 0, name: "linked-helper.exe", cmd: instanceCmdline({ appId: 347559, lhAccountEmail: "license-owner@secret.com" }) },
    ] as never);

    const instances = await scanRunningInstances();
    const serialized = JSON.stringify(instances);
    expect(serialized).not.toContain("license-owner@secret.com");
  });
});

// ---------------------------------------------------------------------------
// Orphan detection
// ---------------------------------------------------------------------------

describe("scanOrphans", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPidToPorts.mockResolvedValue(new Set());
    mockedIsCdpPort.mockResolvedValue(false);
  });

  it("returns zero orphans when every non-connectable is a --type= child of a live parent", async () => {
    // Live instance (connectable)
    mockedPidToPorts.mockImplementation(async (pid: number) => {
      if (pid === 13004) return new Set([54321]);
      return new Set();
    });
    mockedIsCdpPort.mockImplementation(async (port: number) => port === 54321);

    mockedPsList.mockResolvedValue([
      { pid: 13004, ppid: 0, name: "linked-helper.exe", cmd: instanceCmdline({ appId: 347559 }) },
      { pid: 8008, ppid: 13004, name: "linked-helper.exe", cmd: helperCmdline("utility") },
      { pid: 8009, ppid: 13004, name: "linked-helper.exe", cmd: helperCmdline("gpu-process") },
    ] as never);

    const liveInstances = await scanRunningInstances();
    const orphans = await scanOrphans(liveInstances);
    expect(orphans).toHaveLength(0);
  });

  it("detects non-connectable instance-side process as orphan", async () => {
    mockedPsList.mockResolvedValue([
      // A stale non-connectable instance process (not a helper child)
      { pid: 9999, ppid: 0, name: "linked-helper.exe", cmd: instanceCmdline({ appId: 347559 }) },
    ] as never);

    const liveInstances: never[] = [];
    const orphans = await scanOrphans(liveInstances);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.pid).toBe(9999);
    expect(orphans[0]?.accountId).toBe(347559);
  });

  it("does not report live connectable instances as orphans", async () => {
    mockedPidToPorts.mockImplementation(async (pid: number) => {
      if (pid === 13004) return new Set([54321]);
      return new Set();
    });
    mockedIsCdpPort.mockImplementation(async (port: number) => port === 54321);

    mockedPsList.mockResolvedValue([
      { pid: 13004, ppid: 0, name: "linked-helper.exe", cmd: instanceCmdline({ appId: 347559 }) },
    ] as never);

    const liveInstances = await scanRunningInstances();
    const orphans = await scanOrphans(liveInstances);
    expect(orphans).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// reapOrphans
// ---------------------------------------------------------------------------

describe("reapOrphans", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeOrphan(pid: number, accountId: number | null = null): OrphanProcess {
    return { pid, cdpPort: null, accountId, reason: "non-connectable account-instance process" };
  }

  it("dry-run: returns action=dry-run for all orphans without killing", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const orphans = [makeOrphan(1001, 347559), makeOrphan(1002, 329925)];

    const results = await reapOrphans(orphans, false);

    expect(killSpy).not.toHaveBeenCalled();
    expect(results).toEqual([
      { pid: 1001, action: "dry-run" },
      { pid: 1002, action: "dry-run" },
    ]);
  });

  it("confirm: sends SIGKILL to each orphan and returns action=killed", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const orphans = [makeOrphan(2001, 111), makeOrphan(2002, 222)];

    const results = await reapOrphans(orphans, true);

    expect(killSpy).toHaveBeenCalledTimes(2);
    expect(killSpy).toHaveBeenCalledWith(2001, "SIGKILL");
    expect(killSpy).toHaveBeenCalledWith(2002, "SIGKILL");
    expect(results).toEqual([
      { pid: 2001, action: "killed" },
      { pid: 2002, action: "killed" },
    ]);
  });

  it("confirm: returns action=skipped with error reason when kill throws", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH: no such process");
    });
    const orphans = [makeOrphan(3001, 333)];

    const results = await reapOrphans(orphans, true);

    expect(results).toEqual([
      { pid: 3001, action: "skipped", reason: "ESRCH: no such process" },
    ]);
  });

  it("returns empty array when given empty input (dry-run and confirm)", async () => {
    expect(await reapOrphans([], false)).toEqual([]);
    expect(await reapOrphans([], true)).toEqual([]);
  });

  it("confirm: processes that no longer exist at kill time are reported as skipped", async () => {
    const killSpy = vi.spyOn(process, "kill")
      .mockImplementationOnce(() => true)
      .mockImplementationOnce(() => { throw new Error("ESRCH"); });
    const orphans = [makeOrphan(4001, 444), makeOrphan(4002, 555)];

    const results = await reapOrphans(orphans, true);

    expect(results[0]).toEqual({ pid: 4001, action: "killed" });
    expect(results[1]).toEqual({ pid: 4002, action: "skipped", reason: "ESRCH" });
    expect(killSpy).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Connectable-first ordering
// ---------------------------------------------------------------------------

describe("result ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sorts connectable instances before non-connectable", async () => {
    mockedPidToPorts.mockImplementation(async (pid: number) => {
      if (pid === 200) return new Set([54321]);
      return new Set();
    });
    mockedIsCdpPort.mockImplementation(async (port: number) => port === 54321);

    mockedPsList.mockResolvedValue([
      { pid: 100, ppid: 0, name: "linked-helper.exe", cmd: instanceCmdline({ appId: 111 }) }, // not connectable
      { pid: 200, ppid: 0, name: "linked-helper.exe", cmd: instanceCmdline({ appId: 222 }) }, // connectable
    ] as never);

    const instances = await scanRunningInstances();
    expect(instances[0]?.pid).toBe(200);
    expect(instances[0]?.connectable).toBe(true);
    expect(instances[1]?.pid).toBe(100);
    expect(instances[1]?.connectable).toBe(false);
  });
});
