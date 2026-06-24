// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

vi.mock("./gather-raw-processes.js", () => ({
  gatherRawProcesses: vi.fn(),
}));

vi.mock("pid-port", () => ({
  portToPid: vi.fn(),
  pidToPorts: vi.fn(),
}));

// psList is still imported by killInstanceProcesses; keep the mock to prevent
// real OS calls if that path is ever triggered in tests.
vi.mock("ps-list", () => ({
  default: vi.fn().mockResolvedValue([]),
}));

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverInstancePort } from "./instance-discovery.js";
import { gatherRawProcesses } from "./gather-raw-processes.js";
import { pidToPorts, portToPid } from "pid-port";
import type { RawProcess } from "./gather-raw-processes.js";

const mockedGatherRawProcesses = vi.mocked(gatherRawProcesses);

function proc(pid: number, ppid: number, cmdline: string | null = null): RawProcess {
  return { pid, ppid, name: "linked-helper.exe", cmdline };
}

describe("discoverInstancePort", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("[]", { status: 200 }),
    );
    mockedGatherRawProcesses.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should return null when launcher is not running", async () => {
    vi.mocked(portToPid).mockRejectedValue(
      new Error("Could not find a process that uses port `9222`"),
    );

    const port = await discoverInstancePort(9222);
    expect(port).toBeNull();
  });

  it("should return null when portToPid returns undefined", async () => {
    vi.mocked(portToPid).mockResolvedValue(undefined as never);

    const port = await discoverInstancePort(9222);
    expect(port).toBeNull();
  });

  it("should return null when launcher has no children", async () => {
    vi.mocked(portToPid).mockResolvedValue(12345 as never);
    mockedGatherRawProcesses.mockResolvedValue([
      proc(99999, 1),
    ]);

    const port = await discoverInstancePort(9222);
    expect(port).toBeNull();
  });

  it("should discover instance port via cmdline (authoritative path)", async () => {
    vi.mocked(portToPid).mockResolvedValue(12345 as never);
    mockedGatherRawProcesses.mockResolvedValue([
      proc(12346, 12345, "linked-helper.exe --remote-debugging-port=55123"),
      proc(99999, 1),
    ]);

    const port = await discoverInstancePort(9222);
    expect(port).toBe(55123);
    // pidToPorts must NOT have been called — cmdline is authoritative
    expect(pidToPorts).not.toHaveBeenCalled();
  });

  it("should return null when cmdline port does not respond to CDP", async () => {
    vi.mocked(portToPid).mockResolvedValue(12345 as never);
    mockedGatherRawProcesses.mockResolvedValue([
      proc(12346, 12345, "linked-helper.exe --remote-debugging-port=55123"),
    ]);
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("ECONNREFUSED"));

    const port = await discoverInstancePort(9222);
    expect(port).toBeNull();
  });

  it("should fall back to pidToPorts when no cmdline hint is available", async () => {
    vi.mocked(portToPid).mockResolvedValue(12345 as never);
    mockedGatherRawProcesses.mockResolvedValue([
      proc(12346, 12345, null),  // no cmdline
      proc(99999, 1),
    ]);
    vi.mocked(pidToPorts).mockResolvedValue(new Set([55123]) as never);

    const port = await discoverInstancePort(9222);
    expect(port).toBe(55123);
  });

  it("should discover instance port from grandchild process", async () => {
    vi.mocked(portToPid).mockResolvedValue(12345 as never);
    mockedGatherRawProcesses.mockResolvedValue([
      // Direct child (helper/renderer) — no CDP port
      proc(12346, 12345, null),
      // Grandchild (instance) — has CDP port via cmdline
      proc(12347, 12346, "linked-helper.exe --remote-debugging-port=55123"),
      proc(99999, 1),
    ]);

    const port = await discoverInstancePort(9222);
    expect(port).toBe(55123);
  });

  it("should skip cmdline port matching the launcher port", async () => {
    vi.mocked(portToPid).mockResolvedValue(12345 as never);
    mockedGatherRawProcesses.mockResolvedValue([
      // cmdline specifies the launcher port — should be excluded
      proc(12346, 12345, "linked-helper.exe --remote-debugging-port=9222"),
    ]);

    const port = await discoverInstancePort(9222);
    expect(port).toBeNull();
  });

  it("should use default launcher port 9222", async () => {
    vi.mocked(portToPid).mockResolvedValue(12345 as never);
    mockedGatherRawProcesses.mockResolvedValue([
      proc(12346, 12345, "linked-helper.exe --remote-debugging-port=44444"),
    ]);

    const port = await discoverInstancePort();
    expect(port).toBe(44444);
    expect(portToPid).toHaveBeenCalledWith({ port: 9222, host: "*" });
  });

  it("should return null when pidToPorts throws (fallback path, no cmdline)", async () => {
    vi.mocked(portToPid).mockResolvedValue(12345 as never);
    mockedGatherRawProcesses.mockResolvedValue([
      proc(12346, 12345, null),
    ]);
    vi.mocked(pidToPorts).mockRejectedValue(new Error("failed"));

    const port = await discoverInstancePort(9222);
    expect(port).toBeNull();
  });

  it("should return null when gatherRawProcesses fails (treated as no descendants)", async () => {
    vi.mocked(portToPid).mockResolvedValue(12345 as never);
    mockedGatherRawProcesses.mockRejectedValue(new Error("failed"));

    const port = await discoverInstancePort(9222);
    expect(port).toBeNull();
  });

  it("should skip ports that do not respond to CDP (fallback path)", async () => {
    vi.mocked(portToPid).mockResolvedValue(12345 as never);
    mockedGatherRawProcesses.mockResolvedValue([
      proc(12346, 12345, null),
    ]);
    vi.mocked(pidToPorts).mockResolvedValue(
      new Set([50000, 50001]) as never,
    );

    // Port 50000 rejects (not CDP), port 50001 responds
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes(":50000/")) {
        throw new Error("ECONNREFUSED");
      }
      return new Response("[]", { status: 200 });
    });

    const port = await discoverInstancePort(9222);
    expect(port).toBe(50001);
  });

  it("should return null when no port responds to CDP (fallback path)", async () => {
    vi.mocked(portToPid).mockResolvedValue(12345 as never);
    mockedGatherRawProcesses.mockResolvedValue([
      proc(12346, 12345, null),
    ]);
    vi.mocked(pidToPorts).mockResolvedValue(new Set([50000]) as never);

    vi.mocked(globalThis.fetch).mockRejectedValue(
      new Error("ECONNREFUSED"),
    );

    const port = await discoverInstancePort(9222);
    expect(port).toBeNull();
  });
});
