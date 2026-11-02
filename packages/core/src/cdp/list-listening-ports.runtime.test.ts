// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { exec } = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
vi.mock("node:util", () => ({ promisify: () => exec }));
vi.mock("pid-port", () => ({ pidToPorts: vi.fn(), portToPid: vi.fn() }));
import { findListeningTcpPid, listListeningTcpPorts } from "./list-listening-ports.js";
import { portToPid } from "pid-port";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("process", { ...process, platform: "win32" });
});
afterEach(() => vi.unstubAllGlobals());

describe("native Windows listener fallback", () => {
  it("queries the TCP provider when netstat omits a live listener", async () => {
    exec.mockResolvedValueOnce({ stdout: "Active Connections\r\n" })
      .mockResolvedValueOnce({ stdout: "[50123,50122,50123]" });
    expect(await listListeningTcpPorts(42)).toEqual([50122, 50123]);
    expect(exec.mock.calls[1]?.[0]).toBe("powershell.exe");
    const command = exec.mock.calls[1]?.[1].join(" ");
    expect(command).toContain("-OwningProcess 42");
    expect(command).toContain("$_.RemotePort -eq 0");
    expect(command).not.toContain("-State Listen");
    expect(exec.mock.calls[1]?.[2]).toMatchObject({ windowsHide: true, timeout: 15000 });
  });

  it("keeps netstat as the fast path", async () => {
    exec.mockResolvedValueOnce({ stdout: " TCP 127.0.0.1:9222 0.0.0.0:0 LISTENING 42" });
    expect(await listListeningTcpPorts(42)).toEqual([9222]);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("can recover from a failed netstat command and report no listeners", async () => {
    exec.mockRejectedValueOnce(new Error("netstat unavailable"))
      .mockResolvedValueOnce({ stdout: "[]" });
    expect(await listListeningTcpPorts(42)).toEqual([]);
  });

  it.each(["null", "[0]", "[65536]", '["9222"]', "malformed"])('rejects invalid TCP provider output %s', async (stdout) => {
    exec.mockResolvedValueOnce({ stdout: "" }).mockResolvedValueOnce({ stdout });
    await expect(listListeningTcpPorts(42)).rejects.toThrow();
  });

  it("reports failure when both enumeration commands fail", async () => {
    exec.mockRejectedValue(new Error("access denied"));
    await expect(listListeningTcpPorts(42)).rejects.toThrow("Windows TCP enumeration failed");
  });

  it("resolves an unknown-state listener's owning PID without netstat", async () => {
    exec.mockResolvedValueOnce({ stdout: "[123456,123456]" });
    expect(await findListeningTcpPid(9222)).toBe(123456);
    expect(exec.mock.calls[0]?.[1].join(" ")).toContain("-LocalPort 9222");
    expect(exec.mock.calls[0]?.[1].join(" ")).toContain("-ExpandProperty OwningProcess");
  });

  it.each(["[]", "[123,456]"])("does not guess an absent or ambiguous owner: %s", async (stdout) => {
    exec.mockResolvedValueOnce({ stdout });
    expect(await findListeningTcpPid(9222)).toBeNull();
  });

  it("rejects an invalid port before spawning a shell", async () => {
    await expect(findListeningTcpPid(65536)).rejects.toThrow("Invalid TCP port");
    expect(exec).not.toHaveBeenCalled();
  });

  it.each([123, undefined])("preserves non-Windows lookup behavior: %s", async (pid) => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    vi.mocked(portToPid).mockResolvedValue(pid as never);
    expect(await findListeningTcpPid(9222)).toBe(pid ?? null);
    expect(portToPid).toHaveBeenCalledWith({ port: 9222, host: "*" });
    expect(exec).not.toHaveBeenCalled();
  });
});
