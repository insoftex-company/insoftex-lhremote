// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../cdp/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cdp/index.js")>();
  return {
    ...actual,
    scanRunningInstances: vi.fn(),
    waitForConnectable: vi.fn(),
    withLauncherQueue: vi.fn(
      // Passthrough — execute op immediately, no settle
      async (op: () => Promise<unknown>) => op(),
    ),
    invalidateProcessCache: vi.fn(),
  };
});

vi.mock("./instance-lifecycle.js", () => ({
  startInstanceWithRecovery: vi.fn(),
  waitForPidExit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./launcher-recovery.js", () => ({
  acquireLauncherWithRecovery: vi.fn(),
  withLauncherRecovery: vi.fn(
    async (_launcher: unknown, op: () => Promise<unknown>) => ({
      result: await op(),
      launcherRecovered: false,
    }),
  ),
}));

import { scanRunningInstances, waitForConnectable } from "../cdp/index.js";
import type { RunningInstance } from "../cdp/index.js";
import { startInstanceWithRecovery, waitForPidExit } from "./instance-lifecycle.js";
import { acquireLauncherWithRecovery } from "./launcher-recovery.js";
import { restartInstance } from "./restart-instance.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInstance(overrides: Partial<RunningInstance> = {}): RunningInstance {
  return {
    pid: 100,
    accountId: 42,
    cdpPort: 55001,
    connectable: true,
    helperChildCount: 0,
    source: "cmdline",
    confidence: "high",
    ...overrides,
  };
}

const mockLauncher = {
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  stopInstance: vi.fn().mockResolvedValue(undefined),
  startInstance: vi.fn().mockResolvedValue(undefined),
  listAccounts: vi.fn().mockResolvedValue([]),
  currentPort: 9222,
} as unknown as import("./launcher.js").LauncherService;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("restartInstance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(acquireLauncherWithRecovery).mockResolvedValue({
      launcher: mockLauncher,
      launcherPreRecovered: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns restarted:false when instance is already connectable and force is false", async () => {
    vi.mocked(scanRunningInstances).mockResolvedValue([
      makeInstance({ accountId: 42, connectable: true, pid: 100, cdpPort: 55001 }),
    ]);

    const result = await restartInstance(9222, {}, 42);

    expect(result.restarted).toBe(false);
    expect(result.verified).toBe(true);
    expect(result.oldPid).toBe(100);
    expect(vi.mocked(mockLauncher.stopInstance)).not.toHaveBeenCalled();
  });

  it("restarts when force:true even if already connectable", async () => {
    vi.mocked(scanRunningInstances).mockResolvedValue([
      makeInstance({ accountId: 42, connectable: true, pid: 100, cdpPort: 55001 }),
    ]);
    vi.mocked(startInstanceWithRecovery).mockResolvedValue({
      status: "started",
      port: 55002,
      pid: 200,
      verified: true,
    });
    vi.mocked(waitForConnectable).mockResolvedValue({
      cdpPort: 55002,
      pid: 200,
      verified: true,
    });

    const result = await restartInstance(9222, {}, 42, { force: true });

    expect(result.restarted).toBe(true);
    expect(vi.mocked(mockLauncher.stopInstance)).toHaveBeenCalledWith(42);
    expect(vi.mocked(waitForPidExit)).toHaveBeenCalledWith(100, undefined, undefined);
  });

  it("happy path: stop→exit→start→connectable", async () => {
    // Initial scan: instance running
    vi.mocked(scanRunningInstances).mockResolvedValue([
      makeInstance({ accountId: 42, connectable: false, pid: 100 }),
    ]);
    vi.mocked(startInstanceWithRecovery).mockResolvedValue({
      status: "started",
      port: 55002,
      pid: 200,
      verified: true,
    });
    vi.mocked(waitForConnectable).mockResolvedValue({
      cdpPort: 55002,
      pid: 200,
      verified: true,
    });

    const result = await restartInstance(9222, {}, 42);

    expect(result.restarted).toBe(true);
    expect(result.oldPid).toBe(100);
    expect(result.newPid).toBe(200);
    expect(result.cdpPort).toBe(55002);
    expect(result.verified).toBe(true);
    expect(vi.mocked(waitForPidExit)).toHaveBeenCalledWith(100, undefined, undefined);
  });

  it("returns verified:false when start times out AND process inspection finds nothing", async () => {
    vi.mocked(scanRunningInstances).mockResolvedValue([
      makeInstance({ accountId: 42, connectable: false, pid: 100 }),
    ]);
    vi.mocked(startInstanceWithRecovery).mockResolvedValue({ status: "timeout" });
    // Process inspection also finds nothing — genuinely failed.
    vi.mocked(waitForConnectable).mockResolvedValue({
      cdpPort: null,
      pid: undefined,
      verified: false,
    });

    const result = await restartInstance(9222, {}, 42);

    expect(result.restarted).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.cdpPort).toBeNull();
  });

  // F1 key scenario: startInstanceWithRecovery returns "timeout" because the
  // launcher port-hopped, but waitForConnectable (process inspection) finds
  // the new instance → must return verified:true without the launcher CDP.
  it("returns verified:true via process inspection when startInstanceWithRecovery times out (launcher port-hop)", async () => {
    vi.mocked(scanRunningInstances).mockResolvedValue([
      makeInstance({ accountId: 42, connectable: false, pid: 100, cdpPort: 55001 }),
    ]);
    vi.mocked(startInstanceWithRecovery).mockResolvedValue({ status: "timeout" });
    // Process inspection finds the new instance on a distinct port.
    vi.mocked(waitForConnectable).mockResolvedValue({
      cdpPort: 55002,
      pid: 200,
      verified: true,
    });

    const result = await restartInstance(9222, {}, 42);

    expect(result.restarted).toBe(true);
    // THE CRITICAL ASSERTION: verified:true even though launcher timed out.
    expect(result.verified).toBe(true);
    expect(result.newPid).toBe(200);
    expect(result.cdpPort).toBe(55002);
    expect(result.note).toBeUndefined(); // no note because startCommandIssued=true
    expect(waitForConnectable).toHaveBeenCalled();
  });

  // F1: launcher drops so hard that withLauncherRecovery throws (cap exceeded)
  // — process inspection still confirms the new instance → verified:true.
  it("returns verified:true via process inspection when withLauncherRecovery throws after cap", async () => {
    vi.mocked(scanRunningInstances).mockResolvedValue([
      makeInstance({ accountId: 42, connectable: false, pid: 100 }),
    ]);

    // Stop call passes; start call throws (simulates cap exceeded).
    let callCount = 0;
    const { withLauncherRecovery } = await import("./launcher-recovery.js");
    vi.mocked(withLauncherRecovery).mockImplementation(async (_launcher, op) => {
      callCount++;
      if (callCount === 2) {
        // Second call is for the start — launcher cap exceeded.
        throw new Error("LinkedHelperUnreachableError: cap exceeded");
      }
      return { result: await (op as () => Promise<unknown>)(), launcherRecovered: false };
    });

    // Process inspection confirms the instance came up despite the throw.
    vi.mocked(waitForConnectable).mockResolvedValue({
      cdpPort: 55002,
      pid: 200,
      verified: true,
    });

    const result = await restartInstance(9222, {}, 42);

    expect(result.restarted).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.newPid).toBe(200);
    // launcherRecovered is true because the catch block set it.
    expect(result.launcherRecovered).toBe(true);
  });

  // F1: launcher throws AND process inspection finds nothing — structured
  // result with note, never raw legacy error string.
  it("returns verified:false with note when start throws and process inspection finds nothing", async () => {
    vi.mocked(scanRunningInstances).mockResolvedValue([]);

    let callCount = 0;
    const { withLauncherRecovery } = await import("./launcher-recovery.js");
    vi.mocked(withLauncherRecovery).mockImplementation(async (_launcher, op) => {
      callCount++;
      if (callCount === 2) {
        throw new Error("LinkedHelperUnreachableError: cap exceeded");
      }
      return { result: await (op as () => Promise<unknown>)(), launcherRecovered: false };
    });

    vi.mocked(waitForConnectable).mockResolvedValue({
      cdpPort: null,
      pid: undefined,
      verified: false,
    });

    const result = await restartInstance(9222, {}, 42);

    expect(result.restarted).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.cdpPort).toBeNull();
    // Must include a human-readable note — never a raw legacy error string.
    expect(typeof result.note).toBe("string");
    expect(result.note).toContain("launcher CDP dropped");
  });

  it("does not stop other accounts' instances", async () => {
    // Two instances: 42 (target) and 99 (other)
    vi.mocked(scanRunningInstances).mockResolvedValue([
      makeInstance({ accountId: 42, connectable: false, pid: 100 }),
      makeInstance({ accountId: 99, connectable: true, pid: 999, cdpPort: 56000 }),
    ]);
    vi.mocked(startInstanceWithRecovery).mockResolvedValue({
      status: "started",
      port: 55002,
      pid: 200,
      verified: true,
    });
    vi.mocked(waitForConnectable).mockResolvedValue({
      cdpPort: 55002,
      pid: 200,
      verified: true,
    });

    await restartInstance(9222, {}, 42);

    // stopInstance called only for account 42
    expect(vi.mocked(mockLauncher.stopInstance)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(mockLauncher.stopInstance)).toHaveBeenCalledWith(42);
  });

  it("marks verified:false when new port is phantom duplicate of old port", async () => {
    vi.mocked(scanRunningInstances).mockResolvedValue([
      makeInstance({ accountId: 42, connectable: true, pid: 100, cdpPort: 55001 }),
    ]);
    vi.mocked(startInstanceWithRecovery).mockResolvedValue({
      status: "started",
      port: 55001, // Same port as before — phantom
      pid: 200,
      verified: true,
    });
    vi.mocked(waitForConnectable).mockResolvedValue({
      cdpPort: 55001, // Same port
      pid: 200,
      verified: true,
    });

    const result = await restartInstance(9222, {}, 42, { force: true });

    // Port is the same as the old one — consider phantom (not distinct)
    expect(result.verified).toBe(false);
  });
});
