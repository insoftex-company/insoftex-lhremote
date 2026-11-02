// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { accessSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppLaunchError, AppNotFoundError, LinkedHelperUnreachableError } from "./errors.js";
import { AppService } from "./app.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:fs", () => ({
  accessSync: vi.fn(),
  constants: { F_OK: 0, X_OK: 1 },
}));

vi.mock("../cdp/index.js", () => ({
  discoverTargets: vi.fn(),
  findApp: vi.fn(),
}));

vi.mock("get-port", () => ({
  default: vi.fn(),
}));

import { discoverTargets, findApp } from "../cdp/index.js";
import getPort from "get-port";

const mockedSpawn = vi.mocked(spawn);
const mockedExecFile = vi.mocked(execFile);
const mockedAccessSync = vi.mocked(accessSync);
const mockedDiscoverTargets = vi.mocked(discoverTargets);
const mockedFindApp = vi.mocked(findApp);
const mockedGetPort = vi.mocked(getPort);

/** Use zero probe delay in tests to avoid 3s waits. */
const FAST_OPTIONS = { launchProbeDelay: 0 };

function makeMockChild(): ChildProcess {
  type Listener = (...args: unknown[]) => void;
  const listeners = new Map<string, Set<Listener>>();

  const child = {
    unref: vi.fn(),
    kill: vi.fn(),
    on: vi.fn((event: string, handler: Listener) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      (listeners.get(event) as Set<Listener>).add(handler);
      return child;
    }),
    removeListener: vi.fn((event: string, handler: Listener) => {
      listeners.get(event)?.delete(handler);
      return child;
    }),
    pid: 12345,
    exitCode: null as number | null,
  } as unknown as ChildProcess;

  // Helper to simulate process exit from tests
  (child as unknown as { _emitExit: (code: number) => void })._emitExit = (code: number) => {
    (child as unknown as { exitCode: number | null }).exitCode = code;
    for (const handler of listeners.get("exit") ?? []) {
      handler(code, null);
    }
  };

  return child;
}

// The file had no per-test mock lifecycle at all: `restoreAllMocks()` only
// undoes `vi.spyOn` spies, so the `vi.mock()` module mocks below carried both
// their CALL RECORDS and their implementations from one test into the next.
// Three assertions read `expect(mockedSpawn).not.toHaveBeenCalled()`, and in
// declaration order each was green for a different reason: the first because
// no spawning test is declared ahead of it; the second because its own test
// body calls `mockedSpawn.mockClear()` earlier in the same body, deliberately;
// and the third only because that second test happens to be declared right
// before it and leaves the records cleared.  Shuffle the order and the third
// accident disappears and the first stops holding, which is both of the
// failures this file showed.  `resetAllMocks()` drops records and
// implementations both, and the per-describe hooks below run after this one.
// Do not normalise this back to `clearAllMocks` (#846, #928).
//
// `discoverTargets` gets a not-running baseline for a specific reason: reset
// leaves it returning `undefined`, `isRunning()` is
// `try { await discoverTargets(...); return true } catch { return false }`, and
// `await undefined` resolves — so an unconfigured mock would default to
// "already running", which is the very branch the
// `expect(mockedSpawn).not.toHaveBeenCalled()` assertions above exist to test.
// A default that leans toward the passing branch is how those assertions
// became accidental in the first place.  Defaulting to not-running instead
// sends an unconfigured test down the launch path, where a missing `findApp`
// throws loudly.
//
// `unstubAllGlobals()` is the other half, and it is not redundant: a
// `vi.stubGlobal` is undone by neither reset nor restore, so the `process` and
// `fetch` stubs set below otherwise stay installed for the rest of the file —
// including over the Tier-1 network guard that `vitest.setup.ts` installs,
// which CLAUDE.md § Testing calls enforced rather than merely documented.  A
// displaced guard fails open and silently: a later test that would have been
// failed loudly instead receives whatever the leftover stub returns.  No test
// depends on inheriting a stub today — every test that reads `process` or
// `fetch` sets its own, whether in a per-describe hook or in its own body
// (#928).
beforeEach(() => {
  vi.resetAllMocks();
  mockedDiscoverTargets.mockRejectedValue(new Error("not running"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env["LINKEDHELPER_PATH"];
});

describe("AppService", () => {
  describe("cdpPort getter", () => {
    it("returns the explicit port when provided", () => {
      const service = new AppService(9222);
      expect(service.cdpPort).toBe(9222);
    });

    it("throws when no port assigned and launch() not called", () => {
      const service = new AppService();
      expect(() => service.cdpPort).toThrow(/call launch\(\) first/);
    });
  });

  describe("findBinary", () => {
    it("returns the darwin path on macOS", () => {
      vi.stubGlobal("process", { ...process, platform: "darwin", env: {} });
      mockedAccessSync.mockReturnValue(undefined);

      const result = AppService.findBinary();

      expect(result).toBe("/Applications/linked-helper.app/Contents/MacOS/linked-helper");
    });

    it("returns the win32 path on Windows", () => {
      vi.stubGlobal("process", {
        ...process,
        platform: "win32",
        env: {
          LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
          PROGRAMFILES: "C:\\Program Files",
          "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
        },
      });
      mockedAccessSync.mockReturnValue(undefined);

      const result = AppService.findBinary();

      expect(result).toContain("linked-helper.exe");
      expect(result).toContain("Local");
    });

    it("returns the linux path on Linux", () => {
      vi.stubGlobal("process", { ...process, platform: "linux", env: {} });
      mockedAccessSync.mockReturnValue(undefined);

      const result = AppService.findBinary();

      expect(result).toBe("/opt/linked-helper/linked-helper");
    });

    it("uses LINKEDHELPER_PATH env override", () => {
      vi.stubGlobal("process", {
        ...process,
        platform: "darwin",
        env: { LINKEDHELPER_PATH: "/custom/path/lh" },
      });
      mockedAccessSync.mockReturnValue(undefined);

      const result = AppService.findBinary();

      expect(result).toBe("/custom/path/lh");
    });

    it("throws AppNotFoundError when binary does not exist", () => {
      vi.stubGlobal("process", { ...process, platform: "darwin", env: {} });
      mockedAccessSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });

      expect(() => AppService.findBinary()).toThrow(AppNotFoundError);
    });
  });

  describe("isRunning", () => {
    it("returns true when CDP endpoint responds", async () => {
      const service = new AppService(9222);
      mockedDiscoverTargets.mockResolvedValue([]);

      expect(await service.isRunning()).toBe(true);
    });

    it("returns false when CDP endpoint is unreachable", async () => {
      const service = new AppService(9222);
      mockedDiscoverTargets.mockRejectedValue(new Error("connection refused"));

      expect(await service.isRunning()).toBe(false);
    });

    it("returns false when no port is assigned", async () => {
      const service = new AppService();

      expect(await service.isRunning()).toBe(false);
    });
  });

  describe("launch", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.stubGlobal("process", { ...process, platform: "darwin", env: {} });
      mockedFindApp.mockResolvedValue([]);
      mockedExecFile.mockImplementation(((
        _file: string,
        _args: readonly string[],
        _options: { windowsHide?: boolean },
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(null, "", "");
        return {} as ReturnType<typeof execFile>;
      }) as typeof execFile);
    });

    it("skips launch if already running with explicit port", async () => {
      const service = new AppService(9222, FAST_OPTIONS);
      mockedDiscoverTargets.mockResolvedValue([]);

      await service.launch();

      expect(mockedSpawn).not.toHaveBeenCalled();
    });

    it("spawns the binary with explicit CDP port argument", async () => {
      const service = new AppService(9222, FAST_OPTIONS);
      mockedDiscoverTargets.mockRejectedValue(new Error("not running"));
      mockedAccessSync.mockReturnValue(undefined);

      const child = makeMockChild();
      mockedSpawn.mockReturnValue(child);

      await service.launch();

      expect(mockedSpawn).toHaveBeenCalledWith(
        "/Applications/linked-helper.app/Contents/MacOS/linked-helper",
        ["--remote-debugging-port=9222"],
        {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          env: expect.not.objectContaining({ ELECTRON_RUN_AS_NODE: expect.anything() }),
        },
      );
      expect(child.unref).toHaveBeenCalled();
    });

    it("selects a free port via get-port when no port provided", async () => {
      const service = new AppService(undefined, FAST_OPTIONS);
      mockedGetPort.mockResolvedValue(54321);
      mockedAccessSync.mockReturnValue(undefined);

      const child = makeMockChild();
      mockedSpawn.mockReturnValue(child);

      await service.launch();

      expect(mockedGetPort).toHaveBeenCalled();
      expect(mockedSpawn).toHaveBeenCalledWith(expect.any(String), ["--remote-debugging-port=54321"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: expect.not.objectContaining({ ELECTRON_RUN_AS_NODE: expect.anything() }),
      });
      expect(service.cdpPort).toBe(54321);
    });

    it("reuses assigned port on second launch() call", async () => {
      const service = new AppService(undefined, FAST_OPTIONS);
      mockedGetPort.mockResolvedValue(54321);
      mockedAccessSync.mockReturnValue(undefined);

      const child = makeMockChild();
      mockedSpawn.mockReturnValue(child);
      await service.launch();

      expect(service.cdpPort).toBe(54321);

      // Reset call counts for second launch assertions
      mockedGetPort.mockClear();
      mockedSpawn.mockClear();

      // Second launch — port is already assigned, app reported as running
      mockedDiscoverTargets.mockResolvedValue([]);
      await service.launch();

      // getPort must not be called again — port was already assigned
      expect(mockedGetPort).not.toHaveBeenCalled();
      // spawn must not be called again — app is already running
      expect(mockedSpawn).not.toHaveBeenCalled();
      expect(service.cdpPort).toBe(54321);
    });

    it("throws LinkedHelperUnreachableError when only instance is connectable", async () => {
      mockedFindApp.mockResolvedValue([
        { pid: 111, cdpPort: 50982, connectable: false, role: "launcher" as const },
        { pid: 222, cdpPort: 51011, connectable: true, role: "instance" as const },
      ]);

      const service = new AppService(undefined, FAST_OPTIONS);

      await expect(service.launch()).rejects.toThrow(LinkedHelperUnreachableError);
      expect(mockedSpawn).not.toHaveBeenCalled();
    });

    it("throws AppLaunchError on spawn error", async () => {
      const service = new AppService(9222, FAST_OPTIONS);
      mockedDiscoverTargets.mockRejectedValue(new Error("not running"));
      mockedAccessSync.mockReturnValue(undefined);

      const child = makeMockChild();
      (child.on as ReturnType<typeof vi.fn>).mockImplementation((event: string, handler: (err: Error) => void) => {
        if (event === "error") {
          queueMicrotask(() => handler(new Error("ENOENT")));
        }
        return child;
      });
      mockedSpawn.mockReturnValue(child);

      await expect(service.launch()).rejects.toThrow(AppLaunchError);
    });

    it("focuses an existing connectable launcher on Windows", async () => {
      vi.stubGlobal("process", {
        ...process,
        platform: "win32",
        env: {
          LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
          PROGRAMFILES: "C:\\Program Files",
          "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
        },
      });
      mockedFindApp.mockResolvedValue([
        { pid: 111, cdpPort: 9222, connectable: true, role: "launcher" as const },
        { pid: 222, cdpPort: null, connectable: false, role: "instance" as const },
      ]);

      const service = new AppService(undefined, FAST_OPTIONS);
      await service.launch();

      expect(mockedSpawn).not.toHaveBeenCalled();
      expect(service.cdpPort).toBe(9222);
      expect(mockedExecFile).toHaveBeenCalledWith(
        "powershell.exe",
        expect.arrayContaining([
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          expect.stringContaining("111,222"),
        ]),
        expect.objectContaining({ windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 }),
        expect.any(Function),
      );
    });

    it("restores and focuses LinkedHelper windows on Windows by default", async () => {
      vi.stubGlobal("process", {
        ...process,
        platform: "win32",
        env: {
          LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
          PROGRAMFILES: "C:\\Program Files",
          "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
        },
      });
      mockedDiscoverTargets.mockRejectedValue(new Error("not running"));
      mockedAccessSync.mockReturnValue(undefined);
      mockedFindApp.mockResolvedValueOnce([]).mockResolvedValueOnce([
        { pid: 111, cdpPort: 9222, connectable: true, role: "launcher" as const },
        { pid: 222, cdpPort: null, connectable: false, role: "instance" as const },
      ]);

      mockedExecFile.mockImplementation(((
        _file: string,
        _args: readonly string[],
        _options: { windowsHide?: boolean },
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(null, "LinkedHelper\n", "");
        return {} as ReturnType<typeof execFile>;
      }) as typeof execFile);

      const child = makeMockChild();
      mockedSpawn.mockReturnValue(child);

      const service = new AppService(9222, FAST_OPTIONS);
      await service.launch();

      expect(mockedExecFile).toHaveBeenCalledWith(
        "powershell.exe",
        expect.arrayContaining([
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          expect.stringContaining("111,222"),
        ]),
        expect.objectContaining({ windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 }),
        expect.any(Function),
      );
    });

    it("does not try to focus windows when visibility is disabled", async () => {
      vi.stubGlobal("process", {
        ...process,
        platform: "win32",
        env: {
          LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
          PROGRAMFILES: "C:\\Program Files",
          "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
        },
      });
      mockedDiscoverTargets.mockRejectedValue(new Error("not running"));
      mockedAccessSync.mockReturnValue(undefined);

      const child = makeMockChild();
      mockedSpawn.mockReturnValue(child);

      const service = new AppService(9222, { ...FAST_OPTIONS, visible: false });
      await service.launch();

      expect(mockedExecFile).not.toHaveBeenCalled();
    });
  });

  describe("launch with force", () => {
    let mockedProcessKill: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockedProcessKill = vi.fn().mockImplementation((_pid: number, signal: string | number) => {
        if (signal === 0) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      });
      vi.stubGlobal("process", {
        ...process,
        platform: "darwin",
        env: {},
        kill: mockedProcessKill,
      });
      mockedFindApp.mockResolvedValue([]);
    });

    it("refuses a duplicate launch when Windows denies process termination", async () => {
      vi.useFakeTimers();
      try {
        mockedProcessKill.mockImplementation(() => {
          throw Object.assign(new Error("Access denied"), { code: "EPERM" });
        });
        mockedFindApp.mockResolvedValue([{ pid: 111, cdpPort: null, connectable: false, role: "launcher" }]);
        mockedAccessSync.mockReturnValue(undefined);
        mockedSpawn.mockReturnValue(makeMockChild());
        const service = new AppService(9222, { ...FAST_OPTIONS, force: true });
        const pending = service.launch().catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(6000);
        expect(await pending).toBeInstanceOf(AppLaunchError);
        expect(mockedSpawn).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("kills all processes when connectable app exists", async () => {
      mockedFindApp.mockResolvedValue([
        { pid: 111, cdpPort: 9222, connectable: true, role: "launcher" as const },
        { pid: 222, cdpPort: null, connectable: false, role: "instance" as const },
      ]);
      mockedAccessSync.mockReturnValue(undefined);
      mockedGetPort.mockResolvedValue(54321);

      const child = makeMockChild();
      mockedSpawn.mockReturnValue(child);

      const service = new AppService(undefined, { ...FAST_OPTIONS, force: true });
      await service.launch();

      expect(mockedProcessKill).toHaveBeenCalledWith(111, "SIGKILL");
      expect(mockedProcessKill).toHaveBeenCalledWith(222, "SIGKILL");
      expect(mockedSpawn).toHaveBeenCalled();
      expect(service.cdpPort).toBe(54321);
    });

    it("kills unreachable processes before relaunching", async () => {
      mockedFindApp.mockResolvedValue([{ pid: 333, cdpPort: null, connectable: false, role: "launcher" as const }]);
      mockedAccessSync.mockReturnValue(undefined);
      mockedGetPort.mockResolvedValue(54321);

      const child = makeMockChild();
      mockedSpawn.mockReturnValue(child);

      const service = new AppService(undefined, { ...FAST_OPTIONS, force: true });
      await service.launch();

      expect(mockedProcessKill).toHaveBeenCalledWith(333, "SIGKILL");
      expect(mockedSpawn).toHaveBeenCalled();
    });

    it("kills processes even when explicit port is already running", async () => {
      mockedFindApp.mockResolvedValue([{ pid: 444, cdpPort: 9222, connectable: true, role: "launcher" as const }]);
      mockedAccessSync.mockReturnValue(undefined);

      const child = makeMockChild();
      mockedSpawn.mockReturnValue(child);

      const service = new AppService(9222, { ...FAST_OPTIONS, force: true });
      await service.launch();

      expect(mockedProcessKill).toHaveBeenCalledWith(444, "SIGKILL");
      expect(mockedSpawn).toHaveBeenCalledWith(
        expect.any(String),
        ["--remote-debugging-port=9222"],
        expect.any(Object),
      );
    });
  });

  describe("quit", () => {
    beforeEach(() => {
      vi.stubGlobal("process", { ...process, platform: "darwin", env: {} });
      mockedFindApp.mockResolvedValue([]);
    });

    it("closes the owned Windows GUI after the Squirrel bootstrap process already exited", async () => {
      vi.useFakeTimers();
      try {
        vi.stubGlobal("process", { ...process, platform: "win32", env: {} });
        mockedAccessSync.mockReturnValue(undefined);
        const child = makeMockChild();
        mockedSpawn.mockReturnValue(child);
        const service = new AppService(9222, { ...FAST_OPTIONS, visible: false });
        const launch = service.launch();
        await vi.advanceTimersByTimeAsync(2000);
        await launch;
        (child as unknown as { _emitExit: (code: number) => void })._emitExit(0);
        mockedDiscoverTargets.mockResolvedValue([
          {
            id: "owned-launcher",
            type: "page",
            url: "file:///index.html",
            title: "LinkedHelper",
            description: "",
            devtoolsFrontendUrl: "",
          },
        ]);
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal("fetch", fetchMock);
        await service.quit();
        expect(fetchMock).toHaveBeenCalledWith(
          "http://127.0.0.1:9222/json/close/owned-launcher",
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
        expect(child.kill).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("sends SIGTERM and waits for exit", async () => {
      const service = new AppService(9222, FAST_OPTIONS);
      mockedDiscoverTargets.mockRejectedValue(new Error("not running"));
      mockedAccessSync.mockReturnValue(undefined);

      const child = makeMockChild();
      const emitExit = (child as unknown as { _emitExit: (code: number) => void })._emitExit;

      // Simulate process exiting shortly after SIGTERM
      (child.kill as ReturnType<typeof vi.fn>).mockImplementation(() => {
        queueMicrotask(() => emitExit(0));
      });
      mockedSpawn.mockReturnValue(child);

      await service.launch();
      await service.quit();

      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    });

    it("escalates to SIGKILL when process does not exit after SIGTERM", async () => {
      // try/finally, not a trailing useRealTimers(): an assertion failing
      // below would otherwise leave the fake clock installed for every test
      // that runs after this one, and `shouldAdvanceTime` keeps most of them
      // alive — so the cascade is intermittent and lands on the wrong test
      // (#928).
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const service = new AppService(9222, FAST_OPTIONS);
        mockedDiscoverTargets.mockRejectedValue(new Error("not running"));
        mockedAccessSync.mockReturnValue(undefined);

        const child = makeMockChild();
        const emitExit = (child as unknown as { _emitExit: (code: number) => void })._emitExit;

        let killCount = 0;
        (child.kill as ReturnType<typeof vi.fn>).mockImplementation(() => {
          killCount++;
          // Only exit on SIGKILL (second kill call)
          if (killCount === 2) {
            queueMicrotask(() => emitExit(137));
          }
        });
        mockedSpawn.mockReturnValue(child);

        const launchPromise = service.launch();
        await vi.advanceTimersByTimeAsync(2_100);
        await launchPromise;

        const quitPromise = service.quit();
        // Advance past the graceful timeout
        await vi.advanceTimersByTimeAsync(16_000);
        await quitPromise;

        expect(child.kill).toHaveBeenCalledWith("SIGTERM");
        expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not close an externally-detected instance", async () => {
      mockedFindApp.mockResolvedValue([{ pid: 555, cdpPort: 9222, connectable: true, role: "launcher" as const }]);

      const service = new AppService(undefined, FAST_OPTIONS);
      await service.launch();

      // Verify port was reused from detected app
      expect(service.cdpPort).toBe(9222);

      // Set up mocks for the CDP fallback path that quit() must NOT reach
      mockedDiscoverTargets.mockResolvedValue([
        {
          id: "T1",
          type: "page",
          title: "",
          url: "",
          description: "",
          devtoolsFrontendUrl: "",
        },
      ]);
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", mockFetch);

      // quit() must be a no-op — never close an instance we didn't spawn
      await service.quit();

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("falls back to CDP close when no spawned process", async () => {
      const service = new AppService(9222);
      mockedDiscoverTargets.mockResolvedValue([
        {
          id: "T1",
          type: "page",
          title: "",
          url: "",
          description: "",
          devtoolsFrontendUrl: "",
        },
      ]);

      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", mockFetch);

      await service.quit();

      expect(mockFetch).toHaveBeenCalledWith(
        "http://127.0.0.1:9222/json/close/T1",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it("closes the browser-level CDP target when no page targets exist", async () => {
      const service = new AppService(9222);
      mockedDiscoverTargets.mockResolvedValue([]);

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/abc",
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      type Listener = (event?: unknown) => void;
      class MockWebSocket {
        static instances: MockWebSocket[] = [];
        readonly sent: string[] = [];
        private readonly listeners = new Map<string, Set<Listener>>();

        constructor(readonly url: string) {
          MockWebSocket.instances.push(this);
          queueMicrotask(() => this.emit("open"));
        }

        addEventListener(event: string, listener: Listener): void {
          if (!this.listeners.has(event)) this.listeners.set(event, new Set());
          (this.listeners.get(event) as Set<Listener>).add(listener);
        }

        removeEventListener(event: string, listener: Listener): void {
          this.listeners.get(event)?.delete(listener);
        }

        send(data: string): void {
          this.sent.push(data);
          queueMicrotask(() => this.emit("message", { data: JSON.stringify({ id: 1, result: {} }) }));
        }

        close(): void {
          // no-op
        }

        private emit(event: string, payload?: unknown): void {
          for (const listener of this.listeners.get(event) ?? []) {
            listener(payload);
          }
        }
      }

      vi.stubGlobal("WebSocket", MockWebSocket);

      await service.quit();

      expect(mockFetch).toHaveBeenCalledWith(
        "http://127.0.0.1:9222/json/version",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(MockWebSocket.instances[0]?.url).toBe("ws://127.0.0.1:9222/devtools/browser/abc");
      expect(MockWebSocket.instances[0]?.sent).toEqual([JSON.stringify({ id: 1, method: "Browser.close" })]);
    });

    it("does not throw when CDP close fails", async () => {
      const service = new AppService(9222);
      mockedDiscoverTargets.mockRejectedValue(new Error("not running"));

      await expect(service.quit()).resolves.toBeUndefined();
    });

    it("does nothing when no port assigned and no child process", async () => {
      const service = new AppService();

      await expect(service.quit()).resolves.toBeUndefined();
    });
  });
});
