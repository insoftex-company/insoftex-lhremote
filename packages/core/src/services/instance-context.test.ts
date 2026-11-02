// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../cdp/index.js", () => ({
  resolveInstancePort: vi.fn(),
  resolveAppPort: vi.fn(),
}));

vi.mock("../db/index.js", () => ({
  DatabaseClient: vi.fn(),
  discoverDatabase: vi.fn(),
}));

vi.mock("./instance.js", () => ({
  InstanceService: vi.fn(),
}));

vi.mock("./launcher.js", () => ({
  LauncherService: vi.fn(),
}));

import { resolveInstancePort, resolveAppPort } from "../cdp/index.js";
import { DatabaseClient, discoverDatabase } from "../db/index.js";
import { InstanceService } from "./instance.js";
import { LauncherService } from "./launcher.js";
import { UIBlockedError } from "./errors.js";
import { withDatabase, withInstanceDatabase } from "./instance-context.js";

const mockedResolveInstancePort = vi.mocked(resolveInstancePort);
const mockedResolveAppPort = vi.mocked(resolveAppPort);
const mockedDiscoverDatabase = vi.mocked(discoverDatabase);
const mockedDatabaseClient = vi.mocked(DatabaseClient);
const mockedInstanceService = vi.mocked(InstanceService);
const mockedLauncherService = vi.mocked(LauncherService);

function createMockDb(overrides: Partial<DatabaseClient> = {}) {
  const db = {
    close: vi.fn(),
    ...overrides,
  } as unknown as DatabaseClient;
  mockedDatabaseClient.mockImplementation(function () {
    return db;
  });
  return db;
}

function createMockInstance(overrides: Partial<InstanceService> = {}) {
  const instance = {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    setHealthChecker: vi.fn(),
    getInstancePopups: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as InstanceService;
  mockedInstanceService.mockImplementation(function () {
    return instance;
  });
  return instance;
}

function createMockLauncher() {
  const launcher = {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    checkUIHealth: vi.fn().mockResolvedValue({
      healthy: true,
      issues: [],
      popup: null,
      instancePopups: [],
    }),
  } as unknown as LauncherService;
  mockedLauncherService.mockImplementation(function () {
    return launcher;
  });
  return launcher;
}

function extractHealthChecker(mockInstance: InstanceService): () => Promise<void> {
  const calls = vi.mocked(mockInstance.setHealthChecker).mock.calls;
  const firstCall = calls[0];
  if (!firstCall) throw new Error("setHealthChecker was not called");
  return firstCall[0] as () => Promise<void>;
}

describe("withDatabase", () => {
  beforeEach(() => {
    // reset, not clear: clearAllMocks drops call records but keeps mock
    // implementations, which is how one test's setup used to leak into the
    // next. Do not normalise this back to clearAllMocks (#846).
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes valid DatabaseContext to callback", async () => {
    const mockDb = createMockDb();
    mockedDiscoverDatabase.mockReturnValue("/path/to/db.db");

    let receivedCtx: unknown;
    await withDatabase(42, (ctx) => {
      receivedCtx = ctx;
    });

    expect(receivedCtx).toEqual({ accountId: 42, db: mockDb });
  });

  it("returns the callback result", async () => {
    createMockDb();
    mockedDiscoverDatabase.mockReturnValue("/path/to/db.db");

    const result = await withDatabase(42, () => "hello");

    expect(result).toBe("hello");
  });

  it("returns the callback result for async callbacks", async () => {
    createMockDb();
    mockedDiscoverDatabase.mockReturnValue("/path/to/db.db");

    const result = await withDatabase(42, async () => Promise.resolve(123));

    expect(result).toBe(123);
  });

  it("closes DB after callback completes successfully", async () => {
    const mockDb = createMockDb();
    mockedDiscoverDatabase.mockReturnValue("/path/to/db.db");

    await withDatabase(42, () => undefined);

    expect(mockDb.close).toHaveBeenCalledOnce();
  });

  it("closes DB even when callback throws", async () => {
    const mockDb = createMockDb();
    mockedDiscoverDatabase.mockReturnValue("/path/to/db.db");

    await expect(
      withDatabase(42, () => {
        throw new Error("callback error");
      }),
    ).rejects.toThrow("callback error");

    expect(mockDb.close).toHaveBeenCalledOnce();
  });

  it("passes database options to DatabaseClient", async () => {
    createMockDb();
    mockedDiscoverDatabase.mockReturnValue("/path/to/db.db");

    await withDatabase(42, () => undefined, { readOnly: false });

    expect(mockedDatabaseClient).toHaveBeenCalledWith("/path/to/db.db", {
      readOnly: false,
    });
  });

  it("discovers database for the given accountId", async () => {
    createMockDb();
    mockedDiscoverDatabase.mockReturnValue("/path/to/db.db");

    await withDatabase(99, () => undefined);

    expect(mockedDiscoverDatabase).toHaveBeenCalledWith(99);
  });
});

describe("withInstanceDatabase", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedResolveInstancePort.mockResolvedValue(55123);
    mockedResolveAppPort.mockResolvedValue(9222);
    mockedDiscoverDatabase.mockReturnValue("/path/to/db.db");
    createMockInstance();
    createMockDb();
    createMockLauncher();
  });
  afterEach(() => vi.restoreAllMocks());

  it("binds the account and port before opening either resource", async () => {
    const instance = createMockInstance();
    const db = createMockDb();
    const result = await withInstanceDatabase(9222, 42, (ctx) => ctx);
    expect(mockedResolveInstancePort).toHaveBeenCalledWith(9222, undefined, undefined, 42);
    expect(mockedInstanceService).toHaveBeenCalledWith(55123, undefined);
    expect(mockedDiscoverDatabase).toHaveBeenCalledWith(42);
    expect(result).toEqual({ accountId: 42, instance, db });
    expect(instance.disconnect).toHaveBeenCalledOnce();
    expect(db.close).toHaveBeenCalledOnce();
  });

  it("never opens an instance or database when account verification fails", async () => {
    mockedResolveInstancePort.mockRejectedValue(new Error("account mismatch"));
    await expect(withInstanceDatabase(11111, 42, () => undefined)).rejects.toThrow("account mismatch");
    expect(mockedInstanceService).not.toHaveBeenCalled();
    expect(mockedDatabaseClient).not.toHaveBeenCalled();
  });

  it("passes timeout and database options", async () => {
    await withInstanceDatabase(undefined, 42, () => undefined, { instanceTimeout: 5000, db: { readOnly: false } });
    expect(mockedInstanceService).toHaveBeenCalledWith(55123, { timeout: 5000 });
    expect(mockedDatabaseClient).toHaveBeenCalledWith("/path/to/db.db", { readOnly: false });
  });

  it("cleans up resources on callback failure", async () => {
    const instance = createMockInstance();
    const db = createMockDb();
    await expect(
      withInstanceDatabase(9222, 42, () => {
        throw new Error("callback");
      }),
    ).rejects.toThrow("callback");
    expect(instance.disconnect).toHaveBeenCalledOnce();
    expect(db.close).toHaveBeenCalledOnce();
  });

  it("cleans up a failed instance connection without opening the database", async () => {
    const instance = createMockInstance({ connect: vi.fn().mockRejectedValue(new Error("connect")) });
    await expect(withInstanceDatabase(9222, 42, () => undefined)).rejects.toThrow("connect");
    expect(instance.disconnect).toHaveBeenCalledOnce();
    expect(mockedDatabaseClient).not.toHaveBeenCalled();
  });

  it("remains usable without a launcher", async () => {
    mockedResolveAppPort.mockRejectedValue(new Error("no launcher"));
    const instance = createMockInstance();
    expect(await withInstanceDatabase(undefined, 42, () => "ok")).toBe("ok");
    expect(instance.setHealthChecker).toHaveBeenCalledWith(null);
    expect(mockedLauncherService).not.toHaveBeenCalled();
  });

  it("uses a short launcher session per health check and releases it before returning", async () => {
    const instance = createMockInstance();
    const launcher = createMockLauncher();
    await withInstanceDatabase(9222, 42, async () => {
      expect(launcher.connect).not.toHaveBeenCalled();
      await extractHealthChecker(instance)();
      expect(launcher.checkUIHealth).toHaveBeenCalledWith(42);
      expect(launcher.disconnect).toHaveBeenCalledOnce();
      expect(instance.getInstancePopups).toHaveBeenCalledOnce();
    });
  });

  it("reports blocking instance popups", async () => {
    const instance = createMockInstance({
      getInstancePopups: vi.fn().mockResolvedValue([{ title: "Blocked", closable: false }]),
    });
    await withInstanceDatabase(9222, 42, async () => {
      await expect(extractHealthChecker(instance)()).rejects.toThrow(UIBlockedError);
    });
  });

  it("releases a failed launcher connection and still checks instance popups", async () => {
    const instance = createMockInstance();
    const launcher = createMockLauncher();
    vi.mocked(launcher.connect).mockRejectedValue(new Error("launcher unavailable"));
    await withInstanceDatabase(9222, 42, async () => {
      await expect(extractHealthChecker(instance)()).resolves.toBeUndefined();
      expect(instance.getInstancePopups).toHaveBeenCalledOnce();
      expect(launcher.disconnect).toHaveBeenCalledOnce();
    });
  });
});
