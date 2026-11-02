// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

// ---------------------------------------------------------------------------
// Hoisted mock factories — created before vi.mock() calls
// ---------------------------------------------------------------------------

const { connectMock, reconnectMock, disconnectMock, resolveLauncherPortMock } = vi.hoisted(() => ({
  connectMock: vi.fn<() => Promise<void>>(),
  reconnectMock: vi.fn<(opts?: { timeoutMs?: number }) => Promise<void>>(),
  disconnectMock: vi.fn<() => void>(),
  resolveLauncherPortMock: vi.fn<(port?: number, host?: string, retryTimeout?: number) => Promise<number>>(),
}));

// ---------------------------------------------------------------------------
// Module-level mocks — must be hoisted before any imports from the module
// ---------------------------------------------------------------------------

vi.mock("../cdp/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cdp/index.js")>();
  return { ...actual, resolveLauncherPort: resolveLauncherPortMock };
});

vi.mock("./launcher.js", () => {
  class MockLauncherService {
    private _port: number;
    constructor(port: number) { this._port = port; }
    connect = connectMock;
    reconnect = reconnectMock;
    disconnect = disconnectMock;
    get currentPort() { return this._port; }
  }
  return { LauncherService: MockLauncherService, DEFAULT_LAUNCHER_RECOVERY_TIMEOUT_MS: 30_000 };
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CDPConnectionError } from "../cdp/index.js";
import { LinkedHelperUnreachableError, LinkedHelperNotRunningError } from "./errors.js";
import { acquireLauncherWithRecovery } from "./launcher-recovery.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUnreachableError(): LinkedHelperUnreachableError {
  return new LinkedHelperUnreachableError([
    { pid: 12345, cdpPort: 9222, connectable: false, role: "launcher" },
  ]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("acquireLauncherWithRecovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveLauncherPortMock.mockResolvedValue(9222);
    connectMock.mockResolvedValue(undefined);
    reconnectMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns launcherPreRecovered:false when connect succeeds on first try", async () => {
    const { launcher, launcherPreRecovered } = await acquireLauncherWithRecovery(undefined, {});

    expect(launcherPreRecovered).toBe(false);
    expect(connectMock).toHaveBeenCalledOnce();
    expect(reconnectMock).not.toHaveBeenCalled();
    expect(launcher).toBeDefined();
  });

  it("returns launcherPreRecovered:true when connect throws LinkedHelperUnreachableError but reconnect succeeds", async () => {
    connectMock.mockRejectedValueOnce(makeUnreachableError());

    const { launcherPreRecovered } = await acquireLauncherWithRecovery(undefined, {});

    expect(launcherPreRecovered).toBe(true);
    expect(connectMock).toHaveBeenCalledOnce();
    expect(reconnectMock).toHaveBeenCalledOnce();
  });

  it("also recovers when connect throws CDPConnectionError directly", async () => {
    connectMock.mockRejectedValueOnce(new CDPConnectionError("WebSocket closed"));

    const { launcherPreRecovered } = await acquireLauncherWithRecovery(undefined, {});

    expect(launcherPreRecovered).toBe(true);
    expect(reconnectMock).toHaveBeenCalledOnce();
  });

  it("passes recoveryOptions.timeoutMs to reconnect", async () => {
    connectMock.mockRejectedValueOnce(makeUnreachableError());

    await acquireLauncherWithRecovery(undefined, {}, { timeoutMs: 5_000 });

    expect(reconnectMock).toHaveBeenCalledWith({ timeoutMs: 5_000 });
  });

  it("throws structured LinkedHelperUnreachableError (not raw) when reconnect cap exceeded", async () => {
    const unreachable = makeUnreachableError();
    connectMock.mockRejectedValueOnce(unreachable);
    reconnectMock.mockRejectedValueOnce(unreachable);

    const err = await acquireLauncherWithRecovery(undefined, {}).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LinkedHelperUnreachableError);
    expect((err as LinkedHelperUnreachableError).name).toBe("LinkedHelperUnreachableError");
  });

  it("propagates LinkedHelperNotRunningError without attempting reconnect", async () => {
    const notRunning = new LinkedHelperNotRunningError();
    connectMock.mockRejectedValueOnce(notRunning);

    const err = await acquireLauncherWithRecovery(undefined, {}).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LinkedHelperNotRunningError);
    expect(reconnectMock).not.toHaveBeenCalled();
  });

  it("propagates non-connection errors without attempting reconnect", async () => {
    const domainErr = new Error("WrongPortError: this is an instance port");
    connectMock.mockRejectedValueOnce(domainErr);

    const err = await acquireLauncherWithRecovery(undefined, {}).catch((e: unknown) => e);

    expect(err).toBe(domainErr);
    expect(reconnectMock).not.toHaveBeenCalled();
  });

  it("passes explicit cdpPort to resolveLauncherPort", async () => {
    resolveLauncherPortMock.mockResolvedValueOnce(49238);

    await acquireLauncherWithRecovery(49238, {});

    // retryTimeout=0 ensures a fast-fail single scan on the first attempt.
    expect(resolveLauncherPortMock).toHaveBeenCalledWith(49238, undefined, 0);
  });

  it("passes cdpOptions.host to resolveLauncherPort for loopback check", async () => {
    await acquireLauncherWithRecovery(undefined, { host: "127.0.0.1" });

    expect(resolveLauncherPortMock).toHaveBeenCalledWith(undefined, "127.0.0.1", 0);
  });

  it("recovers when resolveLauncherPort throws LinkedHelperUnreachableError (launcher mid-hop)", async () => {
    // Simulates the launcher dropping its CDP port between the initial port
    // scan and the connect attempt — the common port-hop scenario.
    resolveLauncherPortMock.mockRejectedValueOnce(makeUnreachableError());

    const { launcherPreRecovered } = await acquireLauncherWithRecovery(undefined, {});

    expect(launcherPreRecovered).toBe(true);
    // connect() is NOT called when resolve already failed.
    expect(connectMock).not.toHaveBeenCalled();
    expect(reconnectMock).toHaveBeenCalledOnce();
  });
});
