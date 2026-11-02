// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it, vi } from "vitest";

vi.mock("../operation-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../operation-registry.js")>();
  return { ...actual, operationRegistry: new actual.OperationRegistry() };
});

import { operationRegistry } from "../operation-registry.js";
import { registerGetOperation } from "./get-operation.js";
import { createMockServer } from "./testing/mock-server.js";

describe("registerGetOperation", () => {
  it("registers a tool named get-operation", () => {
    const { server } = createMockServer();
    registerGetOperation(server);
    expect(server.tool).toHaveBeenCalledOnce();
    expect(server.tool).toHaveBeenCalledWith(
      "get-operation",
      expect.any(String),
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("returns error for unknown operationId", async () => {
    const { server, getHandler } = createMockServer();
    registerGetOperation(server);
    const handler = getHandler("get-operation");
    const result = await handler({ operationId: "op_does_not_exist" }) as unknown as {
      isError: boolean;
      content: [{ text: string }];
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  it("returns the operation record when found", async () => {
    const { server, getHandler } = createMockServer();
    registerGetOperation(server);
    const handler = getHandler("get-operation");

    const { operationId } = operationRegistry.create("restart-instance");
    const result = await handler({ operationId }) as unknown as { content: [{ text: string }] };
    const parsed = JSON.parse(result.content[0].text) as { operationId: string; kind: string; status: string };
    expect(parsed.operationId).toBe(operationId);
    expect(parsed.kind).toBe("restart-instance");
    expect(parsed.status).toBe("running");
  });

  it("reflects succeeded status after succeed()", async () => {
    const { server, getHandler } = createMockServer();
    registerGetOperation(server);
    const handler = getHandler("get-operation");

    const { operationId } = operationRegistry.create("start-instance");
    operationRegistry.succeed(operationId, { port: 54321 });

    const result = await handler({ operationId }) as unknown as { content: [{ text: string }] };
    const parsed = JSON.parse(result.content[0].text) as { status: string; result: unknown };
    expect(parsed.status).toBe("succeeded");
    expect(parsed.result).toEqual({ port: 54321 });
  });
});
