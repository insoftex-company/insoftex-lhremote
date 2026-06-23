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
    startInstanceWithRecovery: vi.fn(),
    waitForConnectable: vi.fn().mockResolvedValue({ verified: false, cdpPort: null }),
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
  startInstanceWithRecovery,
  waitForConnectable,
} from "@insoftex/lhremote-core";

import { registerStartInstance } from "./start-instance.js";
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

describe("registerStartInstance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: waitForConnectable returns unverified
    vi.mocked(waitForConnectable).mockResolvedValue({ verified: false, cdpPort: null } as unknown as Awaited<ReturnType<typeof waitForConnectable>>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers a tool named start-instance", () => {
    const { server } = createMockServer();
    registerStartInstance(server);

    expect(server.tool).toHaveBeenCalledOnce();
    expect(server.tool).toHaveBeenCalledWith(
      "start-instance",
      expect.any(String),
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("returns success with account and port", async () => {
    const { server, getHandler } = createMockServer();
    registerStartInstance(server);

    mockLauncherConnection();
    vi.mocked(startInstanceWithRecovery).mockResolvedValue({
      status: "started",
      port: 55123,
    });

    const handler = getHandler("start-instance");
    const result = await handler({ accountId: 42, cdpPort: 9222 });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "Instance started for account 42 on CDP port 55123",
        },
      ],
    });
  });

  it("includes PID and verified flag when outcome carries them", async () => {
    const { server, getHandler } = createMockServer();
    registerStartInstance(server);

    mockLauncherConnection();
    vi.mocked(startInstanceWithRecovery).mockResolvedValue({
      status: "started",
      port: 55123,
      pid: 13004,
      verified: true,
    });

    const handler = getHandler("start-instance");
    const result = await handler({ accountId: 42, cdpPort: 9222 });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "Instance started for account 42 on CDP port 55123 — PID 13004 — verified",
        },
      ],
    });
  });

  it("reports NOT verified when verification failed", async () => {
    const { server, getHandler } = createMockServer();
    registerStartInstance(server);

    mockLauncherConnection();
    vi.mocked(startInstanceWithRecovery).mockResolvedValue({
      status: "started",
      port: 55123,
      verified: false,
    });

    const handler = getHandler("start-instance");
    const result = await handler({ accountId: 42, cdpPort: 9222 });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "Instance started for account 42 on CDP port 55123 — NOT verified — duplicate port suspected",
        },
      ],
    });
  });

  it("auto-selects single account when accountId omitted", async () => {
    const { server, getHandler } = createMockServer();
    registerStartInstance(server);

    const accounts: Account[] = [
      { id: 42, liId: 42, name: "Alice" },
    ];

    mockLauncherConnection({
      listAccounts: vi.fn().mockResolvedValue(accounts),
    });
    vi.mocked(startInstanceWithRecovery).mockResolvedValue({
      status: "started",
      port: 55123,
    });

    const handler = getHandler("start-instance");
    const result = await handler({ cdpPort: 9222 });

    expect(startInstanceWithRecovery).toHaveBeenCalledWith(
      expect.anything(),
      42,
      9222,
    );
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "Instance started for account 42 on CDP port 55123",
        },
      ],
    });
  });

  it("returns error when no accounts and accountId omitted", async () => {
    const { server, getHandler } = createMockServer();
    registerStartInstance(server);

    mockLauncherConnection({
      listAccounts: vi.fn().mockResolvedValue([]),
    });

    const handler = getHandler("start-instance");
    const result = await handler({ cdpPort: 9222 });

    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "Failed to start instance: No accounts found." }],
    });
  });

  it("returns error when multiple accounts and accountId omitted", async () => {
    const { server, getHandler } = createMockServer();
    registerStartInstance(server);

    const accounts: Account[] = [
      { id: 1, liId: 1, name: "Alice" },
      { id: 2, liId: 2, name: "Bob" },
    ];

    mockLauncherConnection({
      listAccounts: vi.fn().mockResolvedValue(accounts),
    });

    const handler = getHandler("start-instance");
    const result = await handler({ cdpPort: 9222 });

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "Failed to start instance: Multiple accounts found. Specify accountId. Use list-accounts to see available accounts.",
        },
      ],
    });
  });

  it("returns error when LinkedHelper not running", async () => {
    const { server, getHandler } = createMockServer();
    registerStartInstance(server);

    vi.mocked(acquireLauncherWithRecovery).mockRejectedValue(
      new LinkedHelperNotRunningError(9222),
    );

    const handler = getHandler("start-instance");
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

  it("treats 'already running' as idempotent success when port is discoverable", async () => {
    const { server, getHandler } = createMockServer();
    registerStartInstance(server);

    mockLauncherConnection();
    vi.mocked(startInstanceWithRecovery).mockResolvedValue({
      status: "already_running",
      port: 55123,
    });

    const handler = getHandler("start-instance");
    const result = await handler({ accountId: 42, cdpPort: 9222 });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "Instance already running for account 42 on CDP port 55123",
        },
      ],
    });
  });

  it("returns error when instance fails to initialize within timeout", async () => {
    const { server, getHandler } = createMockServer();
    registerStartInstance(server);

    mockLauncherConnection();
    vi.mocked(startInstanceWithRecovery).mockResolvedValue({ status: "timeout" });
    // waitForConnectable already mocked to return { verified: false }

    const handler = getHandler("start-instance");
    const result = await handler({ accountId: 42, cdpPort: 9222 });

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "Failed to start instance: Instance started but failed to initialize within timeout.",
        },
      ],
    });
  });

  it("returns error on unexpected error", async () => {
    const { server, getHandler } = createMockServer();
    registerStartInstance(server);

    mockLauncherConnection();
    vi.mocked(startInstanceWithRecovery).mockRejectedValue(
      new Error("unexpected failure"),
    );

    const handler = getHandler("start-instance");
    const result = await handler({ accountId: 42, cdpPort: 9222 });

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "Failed to start instance: unexpected failure",
        },
      ],
    });
  });

  it("passes cdpPort to acquireLauncherWithRecovery", async () => {
    const { server, getHandler } = createMockServer();
    registerStartInstance(server);

    mockLauncherConnection({ currentPort: 4567 });
    vi.mocked(startInstanceWithRecovery).mockResolvedValue({
      status: "started",
      port: 55123,
    });

    const handler = getHandler("start-instance");
    await handler({ accountId: 42, cdpPort: 4567 });

    expect(vi.mocked(acquireLauncherWithRecovery)).toHaveBeenCalledWith(
      4567,
      expect.any(Object),
      expect.anything(),
    );
  });

  it("disconnects after successful call", async () => {
    const { server, getHandler } = createMockServer();
    registerStartInstance(server);

    const { disconnect } = mockLauncherConnection();
    vi.mocked(startInstanceWithRecovery).mockResolvedValue({
      status: "started",
      port: 55123,
    });

    const handler = getHandler("start-instance");
    await handler({ accountId: 42, cdpPort: 9222 });

    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("disconnects after error", async () => {
    const { server, getHandler } = createMockServer();
    registerStartInstance(server);

    const { disconnect } = mockLauncherConnection({
      listAccounts: vi.fn().mockResolvedValue([]),
    });

    const handler = getHandler("start-instance");
    await handler({ cdpPort: 9222 });

    expect(disconnect).toHaveBeenCalledOnce();
  });
});
