// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

// ---------------------------------------------------------------------------
// Regression: N instances running + launcher CDP down
//
// Reproduces the exact failure mode reported in the instance-detection bug:
//
//   Six account-instance processes running, each with --app-id and a live
//   CDP port.  The launcher process exists but its CDP socket is NOT
//   answering (started without --remote-debugging-port).
//
// The instance cmdlines do NOT contain resources\out\ in the path — they
// use the same binary as the launcher, distinguished only by --app-id.
// The old code checked for resources\out\ and therefore misclassified every
// instance as role:"launcher", producing runningInstances:[] and blocking
// all write-path tools.
//
// This file asserts criteria A–F from the bug report.
// ---------------------------------------------------------------------------

vi.mock("./gather-raw-processes.js", () => ({
  gatherRawProcesses: vi.fn().mockResolvedValue([]),
}));

vi.mock("pid-port", () => ({
  pidToPorts: vi.fn().mockResolvedValue(new Set<number>()),
  portToPid: vi.fn().mockResolvedValue(null),
}));

vi.mock("../utils/cdp-port.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/cdp-port.js")>();
  return { ...actual, isCdpPort: vi.fn().mockResolvedValue(false) };
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { gatherRawProcesses } from "./gather-raw-processes.js";
import { isCdpPort } from "../utils/cdp-port.js";
import { findApp } from "./app-discovery.js";
import { scanRunningInstances } from "./process-inspector.js";
import type { RawProcess } from "./gather-raw-processes.js";

const mockedGatherRawProcesses = vi.mocked(gatherRawProcesses);
const mockedIsCdpPort = vi.mocked(isCdpPort);

// ---------------------------------------------------------------------------
// Test fixtures — instances use the SAME binary path as the launcher.
// No resources\out\ in the path; identity comes from --app-id alone.
// This matches the real LinkedHelper installation layout.
// ---------------------------------------------------------------------------

const LAUNCHER_PORT = 9222;

interface AccountFixture {
  pid: number;
  appId: number;
  name: string;
  email: string;
  cdpPort: number;
}

const ACCOUNTS: AccountFixture[] = [
  { pid: 14772, appId: 570886, name: "Oleksandra Ivanova", email: "oleksandra@example.com", cdpPort: 49749 },
  { pid: 2440,  appId: 329925, name: "Mike Florko",        email: "mike@example.com",       cdpPort: 51275 },
  { pid: 16428, appId: 331874, name: "Michael Fliorko",    email: "michael@example.com",    cdpPort: 53416 },
  { pid: 16144, appId: 331875, name: "Svitlana Bondar",    email: "svitlana@example.com",   cdpPort: 55539 },
  { pid: 12080, appId: 347559, name: "Vira Lyn",           email: "vira@example.com",       cdpPort: 52247 },
  { pid: 18272, appId: 355899, name: "Dmytro Koval",       email: "dmytro@example.com",     cdpPort: 63842 },
];

/** Instance process — same binary as launcher, with --app-id flag. */
function instanceProc(a: AccountFixture): RawProcess {
  const userLi = JSON.stringify({ id: a.appId, fullName: a.name, email: a.email });
  return {
    pid: a.pid,
    ppid: 9924, // launcher PID
    name: "linked-helper.exe",
    // KEY: path does NOT contain resources\out\ — same binary as launcher.
    // --app-id= is the ONLY discriminator for instance role.
    cmdline:
      `"C:\\Users\\xuser\\AppData\\Local\\Programs\\linked-helper\\linked-helper.exe"` +
      ` --app-id=${String(a.appId)}` +
      ` --user-li-id=${String(a.appId)}` +
      ` "--user-li=${userLi}"` +
      ` --remote-debugging-port=${String(a.cdpPort)}`,
  };
}

/** Launcher process — same binary, no --app-id, CDP socket is DOWN. */
function launcherProc(): RawProcess {
  return {
    pid: 9924,
    ppid: 1,
    name: "linked-helper.exe",
    // No --remote-debugging-port → launcher started without debug flag.
    cmdline:
      `"C:\\Users\\xuser\\AppData\\Local\\Programs\\linked-helper\\linked-helper.exe"`,
  };
}

/** A Chromium helper child of one of the instances. */
function helperProc(pid: number, ppid: number, type: string): RawProcess {
  return {
    pid,
    ppid,
    name: "linked-helper.exe",
    cmdline:
      `"C:\\Users\\xuser\\AppData\\Local\\Programs\\linked-helper\\linked-helper.exe"` +
      ` --type=${type} --renderer-client-id=2`,
  };
}

// ---------------------------------------------------------------------------
// Shared setup: 6 instances UP, launcher CDP DOWN
// ---------------------------------------------------------------------------

function setupSixInstancesLauncherDown(): void {
  const instancePorts = new Set(ACCOUNTS.map((a) => a.cdpPort));

  const first = ACCOUNTS[0] ?? { pid: 0, appId: 0, name: "", email: "", cdpPort: 0 };
  mockedGatherRawProcesses.mockResolvedValue([
    launcherProc(),
    ...ACCOUNTS.map(instanceProc),
    helperProc(20001, first.pid, "gpu-process"),
    helperProc(20002, first.pid, "renderer"),
  ]);

  mockedIsCdpPort.mockImplementation(async (port: number) => {
    // Launcher port (9222) is DOWN; all instance ports are UP.
    if (port === LAUNCHER_PORT) return false;
    return instancePorts.has(port);
  });
}

// ---------------------------------------------------------------------------
// Criterion A: runningInstances is never empty when instance-main processes
//   exist; each entry has correct accountId/name/email, source:"cmdline".
// ---------------------------------------------------------------------------

describe("Criterion A — cmdline-based enumeration with launcher CDP down", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupSixInstancesLauncherDown();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("scanRunningInstances returns all 6 instances despite launcher CDP being down", async () => {
    const instances = await scanRunningInstances();
    expect(instances).toHaveLength(6);
  });

  it("each instance has correct accountId parsed from --app-id (source:cmdline, confidence:high)", async () => {
    const instances = await scanRunningInstances();
    const foundIds = new Set(instances.map((i) => i.accountId));
    for (const a of ACCOUNTS) {
      expect(foundIds.has(a.appId)).toBe(true);
    }
    expect(instances.every((i) => i.source === "cmdline")).toBe(true);
    expect(instances.every((i) => i.confidence === "high")).toBe(true);
  });

  it("each instance has the correct name and email", async () => {
    const instances = await scanRunningInstances();
    const byId = new Map(instances.map((i) => [i.accountId, i]));
    for (const a of ACCOUNTS) {
      const inst = byId.get(a.appId);
      expect(inst).toBeDefined();
      expect(inst?.name).toBe(a.name);
      expect(inst?.email).toBe(a.email);
    }
  });

  it("each instance is connectable with its correct CDP port", async () => {
    const instances = await scanRunningInstances();
    const byId = new Map(instances.map((i) => [i.accountId, i]));
    for (const a of ACCOUNTS) {
      const inst = byId.get(a.appId);
      expect(inst?.cdpPort).toBe(a.cdpPort);
      expect(inst?.connectable).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Criterion B: role classification correctness
//   --app-id → instance; no-app-id/no-type → launcher; --type= → helper-child
// ---------------------------------------------------------------------------

describe("Criterion B — role classification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupSixInstancesLauncherDown();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("no instance process is reported as role:launcher in findApp()", async () => {
    const apps = await findApp();
    const launchers = apps.filter((a) => a.role === "launcher");
    // Only the actual launcher (pid 9924) should be "launcher"
    expect(launchers).toHaveLength(1);
    expect(launchers[0]?.pid).toBe(9924);
  });

  it("all 6 account-instance processes are classified as role:instance", async () => {
    const apps = await findApp();
    const instances = apps.filter((a) => a.role === "instance");
    expect(instances).toHaveLength(6);
    const instancePids = new Set(instances.map((a) => a.pid));
    for (const a of ACCOUNTS) {
      expect(instancePids.has(a.pid)).toBe(true);
    }
  });

  it("helper children are excluded from findApp() default output", async () => {
    const apps = await findApp();
    expect(apps.every((a) => a.role !== "helper-child")).toBe(true);
  });

  it("each instance has identity.accountId matching --app-id", async () => {
    const apps = await findApp();
    const instances = apps.filter((a) => a.role === "instance");
    const byId = new Map(instances.map((a) => [a.identity?.accountId, a]));
    for (const a of ACCOUNTS) {
      const found = byId.get(a.appId);
      expect(found).toBeDefined();
      expect(found?.identity?.source).toBe("cmdline");
      expect(found?.identity?.confidence).toBe("high");
    }
  });
});

// ---------------------------------------------------------------------------
// Criterion D: explicit cdpPort honored by write-path resolution
//
// findApp() is the gating call in resolveInstancePort when cdpPort is explicit.
// We verify it correctly identifies the instance so the write-path can
// use the port without rejecting it as a "launcher" port.
// ---------------------------------------------------------------------------

describe("Criterion D — explicit cdpPort resolves to instance role", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupSixInstancesLauncherDown();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("findApp finds cdpPort 49749 as role:instance and connectable (enables write-path)", async () => {
    const apps = await findApp();
    const match = apps.find(
      (a) => a.cdpPort === 49749 && a.role === "instance" && a.connectable,
    );
    expect(match).toBeDefined();
    expect(match?.identity?.accountId).toBe(570886);
  });

  it("the instance port is NOT reported as a launcher port (prevents write-path rejection)", async () => {
    const apps = await findApp();
    // With the classification bug, cdpPort 49749 was picked up as launcherPort,
    // causing cdpPort !== launcherPort to be false → InstanceNotRunningError.
    const launcherWithPort49749 = apps.find(
      (a) => a.role === "launcher" && a.cdpPort === 49749,
    );
    expect(launcherWithPort49749).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Criterion E: auto-resolution by accountId
//
// scanRunningInstances + accountId lookup covers the no-explicit-port case.
// ---------------------------------------------------------------------------

describe("Criterion E — auto-resolution finds correct instance by accountId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupSixInstancesLauncherDown();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("scanRunningInstances finds account 570886 on port 49749", async () => {
    const instances = await scanRunningInstances();
    const match = instances.find(
      (i) => i.accountId === 570886 && i.connectable && i.cdpPort !== null,
    );
    expect(match).toBeDefined();
    expect(match?.cdpPort).toBe(49749);
  });

  it("each account can be resolved to its unique CDP port", async () => {
    const instances = await scanRunningInstances();
    for (const a of ACCOUNTS) {
      const match = instances.find(
        (i) => i.accountId === a.appId && i.connectable && i.cdpPort !== null,
      );
      expect(match?.cdpPort).toBe(a.cdpPort);
    }
  });
});

// ---------------------------------------------------------------------------
// Criterion F: self-consistency — runningInstances count matches OS reality
// ---------------------------------------------------------------------------

describe("Criterion F — self-consistency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupSixInstancesLauncherDown();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("scanRunningInstances count equals the number of --app-id processes", async () => {
    const instances = await scanRunningInstances();
    // 6 account processes → 6 running instances (helper children excluded)
    expect(instances).toHaveLength(ACCOUNTS.length);
  });

  it("findApp instance count matches scanRunningInstances count", async () => {
    const [apps, instances] = await Promise.all([findApp(), scanRunningInstances()]);
    const appInstances = apps.filter((a) => a.role === "instance");
    expect(appInstances).toHaveLength(instances.length);
  });

  it("findApp instance pids match scanRunningInstances pids", async () => {
    const [apps, instances] = await Promise.all([findApp(), scanRunningInstances()]);
    const appPids = new Set(apps.filter((a) => a.role === "instance").map((a) => a.pid));
    for (const inst of instances) {
      expect(appPids.has(inst.pid)).toBe(true);
    }
  });

  it("no --type= process appears in scanRunningInstances (helper children excluded)", async () => {
    const instances = await scanRunningInstances();
    // PIDs 20001, 20002 are the helper children — they must not appear
    expect(instances.every((i) => i.pid !== 20001 && i.pid !== 20002)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Single instance case: ensures backward compat when only one instance runs
// ---------------------------------------------------------------------------

describe("Single-instance with launcher CDP down", () => {
  const single = ACCOUNTS[0] ?? { pid: 0, appId: 0, name: "", email: "", cdpPort: 0 };

  beforeEach(() => {
    vi.clearAllMocks();
    mockedGatherRawProcesses.mockResolvedValue([
      launcherProc(),
      instanceProc(single),
    ]);
    mockedIsCdpPort.mockImplementation(async (port: number) =>
      port === single.cdpPort,
    );
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("scanRunningInstances returns exactly 1 instance", async () => {
    const instances = await scanRunningInstances();
    expect(instances).toHaveLength(1);
    expect(instances[0]?.accountId).toBe(single.appId);
  });

  it("findApp returns 1 launcher + 1 instance", async () => {
    const apps = await findApp();
    expect(apps.filter((a) => a.role === "launcher")).toHaveLength(1);
    expect(apps.filter((a) => a.role === "instance")).toHaveLength(1);
  });
});
