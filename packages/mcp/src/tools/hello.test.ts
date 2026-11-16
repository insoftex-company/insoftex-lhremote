// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import { registerHello } from "./hello.js";
import { createMockServer } from "./testing/mock-server.js";

describe("registerHello", () => {
  it("registers a tool named hello", () => {
    const { server } = createMockServer();
    registerHello(server, "9.9.9");

    expect(server.tool).toHaveBeenCalledOnce();
    expect(server.tool).toHaveBeenCalledWith("hello", expect.any(String), {}, expect.any(Function));
  });

  it("returns the server version and the running module path", async () => {
    const { server, getHandler } = createMockServer();
    registerHello(server, "9.9.9");

    const result = (await getHandler("hello")({})) as { content: { text: string }[] };
    const report = JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;

    expect(report).toMatchObject({ name: "lhremote", version: "9.9.9", node: process.version, pid: process.pid });
    expect(report["modulePath"]).toMatch(/hello\.ts$/);
  });

  it("reports an unknown version when none is given", async () => {
    const { server, getHandler } = createMockServer();
    registerHello(server);

    const result = (await getHandler("hello")({})) as { content: { text: string }[] };

    expect(JSON.parse(result.content[0]?.text ?? "{}")).toMatchObject({ version: "unknown" });
  });
});
