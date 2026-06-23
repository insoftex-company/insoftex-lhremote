// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it, vi } from "vitest";

vi.mock("../operation-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../operation-registry.js")>();
  return { ...actual, operationRegistry: new actual.OperationRegistry() };
});

import { operationRegistry } from "../operation-registry.js";
import { registerListOperations } from "./list-operations.js";
import { createMockServer } from "./testing/mock-server.js";

describe("registerListOperations", () => {
  it("registers a tool named list-operations", () => {
    const { server } = createMockServer();
    registerListOperations(server);
    expect(server.tool).toHaveBeenCalledOnce();
    expect(server.tool).toHaveBeenCalledWith(
      "list-operations",
      expect.any(String),
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("returns empty array when no operations", async () => {
    const { server, getHandler } = createMockServer();
    registerListOperations(server);
    const handler = getHandler("list-operations");
    const result = await handler({}) as unknown as { content: [{ text: string }] };
    const parsed = JSON.parse(result.content[0].text) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(0);
  });

  it("lists running operations first", async () => {
    const { server, getHandler } = createMockServer();
    registerListOperations(server);
    const handler = getHandler("list-operations");

    const { operationId: id1 } = operationRegistry.create("start-instance");
    operationRegistry.succeed(id1, null);
    const { operationId: id2 } = operationRegistry.create("restart-instance");
    // id2 is running

    const result = await handler({}) as unknown as { content: [{ text: string }] };
    const parsed = JSON.parse(result.content[0].text) as Array<{ operationId: string; status: string }>;
    expect(parsed[0]?.operationId).toBe(id2);
    expect(parsed[0]?.status).toBe("running");
    expect(parsed[1]?.operationId).toBe(id1);
    expect(parsed[1]?.status).toBe("succeeded");
  });
});
