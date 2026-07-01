// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

// ---------------------------------------------------------------------------
// Module-level mocks — must be hoisted before any imports from the module
// ---------------------------------------------------------------------------

vi.mock("./gather-raw-processes.js", () => ({
  gatherRawProcesses: vi.fn().mockResolvedValue([]),
  invalidateProcessCache: vi.fn(),
}));

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { gatherRawProcesses, invalidateProcessCache } from "./gather-raw-processes.js";
import { gatherLhProcesses } from "./gather-lh-processes.js";
import type { RawProcess } from "./gather-raw-processes.js";

const mockedGatherRawProcesses = vi.mocked(gatherRawProcesses);
const mockedInvalidateProcessCache = vi.mocked(invalidateProcessCache);

function proc(pid: number, ppid: number, name: string, cmdline: string | null): RawProcess {
  return { pid, ppid, name, cmdline };
}

describe("gatherLhProcesses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("LHREMOTE_CMDLINE_RETRY_DELAY_MS", "0");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("filters out non-LinkedHelper processes", async () => {
    mockedGatherRawProcesses.mockResolvedValue([
      proc(100, 1, "chrome", "chrome"),
      proc(200, 1, "linked-helper.exe", "linked-helper.exe --remote-debugging-port=9222"),
    ]);

    const result = await gatherLhProcesses();
    expect(result).toHaveLength(1);
    expect(result[0]?.pid).toBe(200);
  });

  it("matches known binary names case-insensitively", async () => {
    mockedGatherRawProcesses.mockResolvedValue([
      proc(100, 1, "LinkedHelper.exe", "cmd"),
      proc(200, 1, "linked-helper", "cmd"),
    ]);

    const result = await gatherLhProcesses();
    expect(result).toHaveLength(2);
  });

  it("returns [] when gatherRawProcesses throws, without retrying", async () => {
    mockedGatherRawProcesses.mockRejectedValue(new Error("permission denied"));

    const result = await gatherLhProcesses();
    expect(result).toEqual([]);
    expect(mockedInvalidateProcessCache).not.toHaveBeenCalled();
  });

  it("does not retry when every matched process already has a cmdline", async () => {
    mockedGatherRawProcesses.mockResolvedValue([
      proc(200, 1, "linked-helper.exe", "linked-helper.exe --remote-debugging-port=9222"),
    ]);

    await gatherLhProcesses();

    expect(mockedInvalidateProcessCache).not.toHaveBeenCalled();
    expect(mockedGatherRawProcesses).toHaveBeenCalledTimes(1);
  });

  it("does not retry when there are no matched LinkedHelper processes at all", async () => {
    mockedGatherRawProcesses.mockResolvedValue([proc(100, 1, "chrome", null)]);

    const result = await gatherLhProcesses();
    expect(result).toEqual([]);
    expect(mockedInvalidateProcessCache).not.toHaveBeenCalled();
  });

  it("retries once, invalidating the cache, when a matched process has cmdline: null", async () => {
    mockedGatherRawProcesses
      .mockResolvedValueOnce([proc(200, 1, "linked-helper.exe", null)])
      .mockResolvedValueOnce([proc(200, 1, "linked-helper.exe", "linked-helper.exe --app-id=347559")]);

    const result = await gatherLhProcesses();

    expect(mockedInvalidateProcessCache).toHaveBeenCalledTimes(1);
    expect(mockedGatherRawProcesses).toHaveBeenCalledTimes(2);
    expect(result[0]?.cmdline).toContain("--app-id=347559");
  });

  it("falls back to the first (null-cmdline) result when the retry itself comes back empty", async () => {
    mockedGatherRawProcesses
      .mockResolvedValueOnce([proc(200, 1, "linked-helper.exe", null)])
      .mockResolvedValueOnce([]);

    const result = await gatherLhProcesses();

    expect(result).toHaveLength(1);
    expect(result[0]?.pid).toBe(200);
    expect(result[0]?.cmdline).toBeNull();
  });

  it("retries only once even if the retried scan still has a null cmdline", async () => {
    mockedGatherRawProcesses.mockResolvedValue([proc(200, 1, "linked-helper.exe", null)]);

    const result = await gatherLhProcesses();

    expect(mockedGatherRawProcesses).toHaveBeenCalledTimes(2);
    expect(result[0]?.cmdline).toBeNull();
  });
});
