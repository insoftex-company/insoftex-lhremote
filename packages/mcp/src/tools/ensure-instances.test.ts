// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@insoftex/lhremote-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@insoftex/lhremote-core")>();
  return {
    ...actual,
    acquireLauncherWithRecovery: vi.fn(),
    ensureInstances: vi.fn(),
  };
});

vi.mock("../operation-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../operation-registry.js")>();
  return {
    ...actual,
    operationRegistry: new actual.OperationRegistry(),
    runAsyncOp: async (
      _registry: unknown,
      _kind: unknown,
      work: (signal: AbortSignal, progress: (msg: string) => void) => Promise<unknown>,
    ) => {
      const ac = new AbortController();
      const result = await work(ac.signal, () => undefined);
      return { status: "completed", result };
    },
  };
});

import {
  type EnsureInstanceResult,
  acquireLauncherWithRecovery,
  ensureInstances,
} from "@insoftex/lhremote-core";

import { registerEnsureInstances } from "./ensure-instances.js";
import { createMockServer } from "./testing/mock-server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockLauncherConnection(port = 9222) {
  const disconnect = vi.fn();
  const mockLauncher = { disconnect, currentPort: port };
  vi.mocked(acquireLauncherWithRecovery).mockResolvedValue(
    { launcher: mockLauncher } as unknown as Awaited<ReturnType<typeof acquireLauncherWithRecovery>>,
  );
  return { disconnect, mockLauncher };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registerEnsureInstances", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers a tool named ensure-instances", () => {
    const { server } = createMockServer();
    registerEnsureInstances(server);

    expect(server.tool).toHaveBeenCalledOnce();
    expect(server.tool).toHaveBeenCalledWith(
      "ensure-instances",
      expect.any(String),
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("returns per-account result table as JSON", async () => {
    const { server, getHandler } = createMockServer();
    registerEnsureInstances(server);

    mockLauncherConnection();

    const results: EnsureInstanceResult[] = [
      { accountId: 1, status: "already_running", cdpPort: 54321, pid: 13004, verified: true },
      { accountId: 2, status: "started", cdpPort: 54322, pid: 13005, verified: true },
    ];
    vi.mocked(ensureInstances).mockResolvedValue(results);

    const handler = getHandler("ensure-instances");
    const result = (await handler({ accountIds: [1, 2], cdpPort: 9222 })) as {
      content: [{ text: string }];
    };

    expect(JSON.parse(result.content[0].text)).toEqual(results);
  });

  it("calls ensureInstances with resolved launcher port", async () => {
    const { server, getHandler } = createMockServer();
    registerEnsureInstances(server);

    mockLauncherConnection(9222);
    vi.mocked(ensureInstances).mockResolvedValue([
      { accountId: 42, status: "already_running", cdpPort: 54321, pid: 100, verified: true },
    ]);

    const handler = getHandler("ensure-instances");
    await handler({ accountIds: [42], cdpPort: 9222 });

    expect(vi.mocked(ensureInstances)).toHaveBeenCalledWith(
      [42],
      expect.any(Object),
      9222,
    );
  });

  it("disconnects after completion", async () => {
    const { server, getHandler } = createMockServer();
    registerEnsureInstances(server);

    const { disconnect } = mockLauncherConnection();
    vi.mocked(ensureInstances).mockResolvedValue([]);

    const handler = getHandler("ensure-instances");
    await handler({ accountIds: [1], cdpPort: 9222 });

    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("disconnects even after error", async () => {
    const { server, getHandler } = createMockServer();
    registerEnsureInstances(server);

    const { disconnect } = mockLauncherConnection();
    vi.mocked(ensureInstances).mockRejectedValue(new Error("boom"));

    const handler = getHandler("ensure-instances");
    const result = await handler({ accountIds: [1], cdpPort: 9222 });

    expect(disconnect).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ isError: true });
  });
});
