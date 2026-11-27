// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import psList from "ps-list";
import { findListeningTcpPid, listListeningTcpPorts } from "./list-listening-ports.js";
import {
  isChromiumAvailable,
  launchChromium,
  type ChromiumInstance,
} from "./testing/launch-chromium.js";

describe.skipIf(!isChromiumAvailable)("instance-discovery packages (integration)", () => {
  let chromium: ChromiumInstance;

  beforeAll(async () => {
    chromium = await launchChromium();
  }, 30_000);

  afterAll(async () => {
    await chromium?.close();
  });

  it("findListeningTcpPid should find the Chromium process by port", async () => {
    expect(chromium).toBeDefined();
    const pid = await findListeningTcpPid(chromium.port);

    expect(pid).toBe(chromium.process.pid);
  }, 20_000);

  it("psList should include the Chromium process with correct ppid", async () => {
    expect(chromium).toBeDefined();
    const processes = await psList();
    const chromiumProc = processes.find(
      (p) => p.pid === chromium.process.pid,
    );

    expect(chromiumProc).toBeDefined();
    expect(chromiumProc?.ppid).toEqual(expect.any(Number));
  });

  it("listListeningTcpPorts should include the Chromium CDP port", async () => {
    expect(chromium).toBeDefined();
    const pid = chromium.process.pid;
    if (pid === undefined) throw new Error("Expected the test Chromium PID");

    const ports = await listListeningTcpPorts(pid);

    expect(Array.isArray(ports)).toBe(true);
    expect(ports).toContain(chromium.port);
    // Windows may need both netstat and a cold PowerShell TCP-provider query;
    // each has a 15 s subprocess bound, beyond Vitest's default 5 s budget.
  }, 35_000);
});
