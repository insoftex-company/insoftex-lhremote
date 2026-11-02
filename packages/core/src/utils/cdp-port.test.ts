// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, describe, expect, it, vi } from "vitest";
import { isCdpPort, parseCmdlineDebugPort } from "./cdp-port.js";

describe("isCdpPort", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // Each test below stubs `fetch` in its own body, and `vi.stubGlobal` is
    // undone by neither reset nor restore — so without this the previous
    // test's stub is what a test that set none would receive, and the Tier-1
    // network guard stays displaced for the rest of the file (#935).
    // `isCdpPort()` is the `catch { return false; }` shape that guard records
    // blocked calls for, so displacing it here loses the one mechanism that
    // would report a real call.
    vi.unstubAllGlobals();
  });

  it("should return true for an empty CDP target list", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));

    expect(await isCdpPort(9222)).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:9222/json/list",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("should return false when the port responds with non-ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));

    expect(await isCdpPort(9222)).toBe(false);
  });

  it("should return false when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    expect(await isCdpPort(9222)).toBe(false);
  });
});

describe("CDP protocol validation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  it.each([{ status: "ok" }, "not CDP", [{ id: 42 }]])(
    "refuses HTTP 200 with a non-CDP payload (%j)",
    async (payload) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => payload }));
      expect(await isCdpPort(11111)).toBe(false);
    },
  );
});

describe("parseCmdlineDebugPort", () => {
  it("extracts port from a typical launcher command line", () => {
    expect(parseCmdlineDebugPort("C:\\path\\linked-helper.exe --remote-debugging-port=9222")).toBe(9222);
  });

  it("extracts a dynamic port (non-9222)", () => {
    expect(parseCmdlineDebugPort("C:\\path\\linked-helper.exe --remote-debugging-port=49238")).toBe(49238);
  });

  it("returns null when the flag is absent", () => {
    expect(parseCmdlineDebugPort("C:\\path\\linked-helper.exe --some-flag=1")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseCmdlineDebugPort("")).toBeNull();
  });

  it("returns null for port 0", () => {
    expect(parseCmdlineDebugPort("linked-helper.exe --remote-debugging-port=0")).toBeNull();
  });

  it("returns null for a port above 65535", () => {
    expect(parseCmdlineDebugPort("linked-helper.exe --remote-debugging-port=99999")).toBeNull();
  });

  it("does not match a substring inside a longer flag name", () => {
    expect(parseCmdlineDebugPort("linked-helper.exe --no-remote-debugging-port=9222")).toBeNull();
  });

  it("extracts port when the whole flag is wrapped in Windows WMI outer double-quotes", () => {
    expect(parseCmdlineDebugPort(`linked-helper.exe "--remote-debugging-port=9222"`)).toBe(9222);
  });

  it('extracts port when the value is quoted (--remote-debugging-port="9222")', () => {
    expect(parseCmdlineDebugPort(`linked-helper.exe --remote-debugging-port="9222"`)).toBe(9222);
  });
});
