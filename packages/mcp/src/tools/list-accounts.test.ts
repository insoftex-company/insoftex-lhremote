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
    withLauncherRecovery: vi.fn(
      async (_launcher: unknown, op: () => Promise<unknown>) => ({
        result: await op(),
        launcherRecovered: false,
      }),
    ),
  };
});

import {
  type Account,
  LinkedHelperNotRunningError,
  acquireLauncherWithRecovery,
} from "@insoftex/lhremote-core";

import { registerListAccounts } from "./list-accounts.js";
import { createMockServer } from "./testing/mock-server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockLauncherConnection(overrides: Partial<{
  disconnect: ReturnType<typeof vi.fn>;
  listAccounts: ReturnType<typeof vi.fn>;
  [key: string]: unknown;
}> = {}) {
  const disconnect = overrides.disconnect ?? vi.fn();
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

describe("registerListAccounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers a tool named list-accounts", () => {
    const { server } = createMockServer();
    registerListAccounts(server);

    expect(server.tool).toHaveBeenCalledOnce();
    expect(server.tool).toHaveBeenCalledWith(
      "list-accounts",
      expect.any(String),
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("returns accounts as JSON", async () => {
    const { server, getHandler } = createMockServer();
    registerListAccounts(server);

    const accounts: Account[] = [
      { id: 1, liId: 100, name: "Alice" },
      { id: 2, liId: 200, name: "Bob", email: "bob@example.com" },
    ];

    mockLauncherConnection({
      listAccounts: vi.fn().mockResolvedValue(accounts),
    });

    const handler = getHandler("list-accounts");
    const result = (await handler({ cdpPort: 9222 })) as {
      content: [{ text: string }];
    };

    expect(JSON.parse(result.content[0].text)).toEqual(accounts);
  });

  it("returns empty array when no accounts", async () => {
    const { server, getHandler } = createMockServer();
    registerListAccounts(server);

    mockLauncherConnection({ listAccounts: vi.fn().mockResolvedValue([]) });

    const handler = getHandler("list-accounts");
    const result = (await handler({ cdpPort: 9222 })) as {
      content: [{ text: string }];
    };

    expect(JSON.parse(result.content[0].text)).toEqual([]);
  });

  it("returns error when LinkedHelper not running", async () => {
    const { server, getHandler } = createMockServer();
    registerListAccounts(server);

    vi.mocked(acquireLauncherWithRecovery).mockRejectedValue(
      new LinkedHelperNotRunningError(9222),
    );

    const handler = getHandler("list-accounts");
    const result = await handler({ cdpPort: 9222 });

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

  it("disconnects after successful call", async () => {
    const { server, getHandler } = createMockServer();
    registerListAccounts(server);

    const { disconnect } = mockLauncherConnection();

    const handler = getHandler("list-accounts");
    await handler({ cdpPort: 9222 });

    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("passes cdpPort to acquireLauncherWithRecovery", async () => {
    const { server, getHandler } = createMockServer();
    registerListAccounts(server);

    mockLauncherConnection();

    const handler = getHandler("list-accounts");
    await handler({ cdpPort: 4567 });

    expect(vi.mocked(acquireLauncherWithRecovery)).toHaveBeenCalledWith(
      4567,
      expect.any(Object),
    );
  });

  it("forwards accountId via buildCdpOptions to acquireLauncherWithRecovery when supplied (regression #793)", async () => {
    const { server, getHandler } = createMockServer();
    registerListAccounts(server);

    mockLauncherConnection();

    const handler = getHandler("list-accounts");
    await handler({ cdpPort: 9222, accountId: 12345 });

    expect(vi.mocked(acquireLauncherWithRecovery)).toHaveBeenCalledWith(
      9222,
      expect.objectContaining({ accountId: 12345 }),
    );
  });
});
