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
    waitForInstanceShutdown: vi.fn().mockResolvedValue(undefined),
    withLauncherQueue: vi.fn(async (op: () => Promise<unknown>) => op()),
    withLauncherRecovery: vi.fn(
      async (_launcher: unknown, op: () => Promise<unknown>) => ({
        result: await op(),
        launcherRecovered: false,
      }),
    ),
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
  type Account,
  LinkedHelperNotRunningError,
  acquireLauncherWithRecovery,
} from "@insoftex/lhremote-core";

import { registerStopInstance } from "./stop-instance.js";
import { createMockServer } from "./testing/mock-server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockLauncherConnection(overrides: Record<string, unknown> = {}) {
  const disconnect = vi.fn();
  const mockLauncher = {
    disconnect,
    currentPort: 9222,
    listAccounts: vi.fn().mockResolvedValue([]),
    stopInstance: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  vi.mocked(acquireLauncherWithRecovery).mockResolvedValue(
    { launcher: mockLauncher } as unknown as Awaited<ReturnType<typeof acquireLauncherWithRecovery>>,
  );
  return { disconnect, mockLauncher };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registerStopInstance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers a tool named stop-instance", () => {
    const { server } = createMockServer();
    registerStopInstance(server);

    expect(server.tool).toHaveBeenCalledOnce();
    expect(server.tool).toHaveBeenCalledWith(
      "stop-instance",
      expect.any(String),
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("returns success when instance stopped", async () => {
    const { server, getHandler } = createMockServer();
    registerStopInstance(server);

    const { mockLauncher } = mockLauncherConnection();

    const handler = getHandler("stop-instance");
    const result = await handler({ accountId: 42, cdpPort: 9222 });

    expect(vi.mocked(mockLauncher.stopInstance)).toHaveBeenCalledWith(42);
    expect(result).toEqual({
      content: [
        { type: "text", text: "Instance stopped for account 42" },
      ],
    });
  });

  it("auto-selects single account when accountId omitted", async () => {
    const { server, getHandler } = createMockServer();
    registerStopInstance(server);

    const accounts: Account[] = [
      { id: 42, liId: 42, name: "Alice" },
    ];

    const { mockLauncher } = mockLauncherConnection({
      listAccounts: vi.fn().mockResolvedValue(accounts),
    });

    const handler = getHandler("stop-instance");
    const result = await handler({ cdpPort: 9222 });

    expect(vi.mocked(mockLauncher.stopInstance)).toHaveBeenCalledWith(42);
    expect(result).toEqual({
      content: [
        { type: "text", text: "Instance stopped for account 42" },
      ],
    });
  });

  it("returns error when no accounts and accountId omitted", async () => {
    const { server, getHandler } = createMockServer();
    registerStopInstance(server);

    mockLauncherConnection({
      listAccounts: vi.fn().mockResolvedValue([]),
    });

    const handler = getHandler("stop-instance");
    const result = await handler({ cdpPort: 9222 });

    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "Failed to stop instance: No accounts found." }],
    });
  });

  it("returns error when multiple accounts and accountId omitted", async () => {
    const { server, getHandler } = createMockServer();
    registerStopInstance(server);

    const accounts: Account[] = [
      { id: 1, liId: 1, name: "Alice" },
      { id: 2, liId: 2, name: "Bob" },
    ];

    mockLauncherConnection({
      listAccounts: vi.fn().mockResolvedValue(accounts),
    });

    const handler = getHandler("stop-instance");
    const result = await handler({ cdpPort: 9222 });

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "Failed to stop instance: Multiple accounts found. Specify accountId. Use list-accounts to see available accounts.",
        },
      ],
    });
  });

  it("returns error when LinkedHelper not running", async () => {
    const { server, getHandler } = createMockServer();
    registerStopInstance(server);

    vi.mocked(acquireLauncherWithRecovery).mockRejectedValue(
      new LinkedHelperNotRunningError(9222),
    );

    const handler = getHandler("stop-instance");
    const result = await handler({ accountId: 42, cdpPort: 9222 });

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "LinkedHelper is not running. Use launch-app first.",
        },
      ],
    });
  });

  it("returns error on unexpected error", async () => {
    const { server, getHandler } = createMockServer();
    registerStopInstance(server);

    mockLauncherConnection({
      stopInstance: vi.fn().mockRejectedValue(new Error("unexpected failure")),
    });

    const handler = getHandler("stop-instance");
    const result = await handler({ accountId: 42, cdpPort: 9222 });

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "Failed to stop instance: unexpected failure",
        },
      ],
    });
  });

  it("passes cdpPort to acquireLauncherWithRecovery", async () => {
    const { server, getHandler } = createMockServer();
    registerStopInstance(server);

    mockLauncherConnection({ currentPort: 4567 });

    const handler = getHandler("stop-instance");
    await handler({ accountId: 42, cdpPort: 4567 });

    expect(vi.mocked(acquireLauncherWithRecovery)).toHaveBeenCalledWith(
      4567,
      expect.any(Object),
      expect.anything(),
    );
  });

  it("disconnects after successful call", async () => {
    const { server, getHandler } = createMockServer();
    registerStopInstance(server);

    const { disconnect } = mockLauncherConnection();

    const handler = getHandler("stop-instance");
    await handler({ accountId: 42, cdpPort: 9222 });

    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("disconnects after error", async () => {
    const { server, getHandler } = createMockServer();
    registerStopInstance(server);

    const { disconnect } = mockLauncherConnection({
      stopInstance: vi.fn().mockRejectedValue(new Error("fail")),
    });

    const handler = getHandler("stop-instance");
    await handler({ accountId: 42, cdpPort: 9222 });

    expect(disconnect).toHaveBeenCalledOnce();
  });
});
