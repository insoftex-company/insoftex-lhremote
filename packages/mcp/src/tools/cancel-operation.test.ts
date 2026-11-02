// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@insoftex/lhremote-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@insoftex/lhremote-core")>();
  return { ...actual, scanRunningInstances: vi.fn() };
});

vi.mock("../operation-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../operation-registry.js")>();
  return { ...actual, operationRegistry: new actual.OperationRegistry() };
});

import { scanRunningInstances } from "@insoftex/lhremote-core";
import { operationRegistry } from "../operation-registry.js";
import { registerCancelOperation } from "./cancel-operation.js";
import { createMockServer } from "./testing/mock-server.js";

const mockedScan = vi.mocked(scanRunningInstances);

describe("registerCancelOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedScan.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers a tool named cancel-operation", () => {
    const { server } = createMockServer();
    registerCancelOperation(server);
    expect(server.tool).toHaveBeenCalledOnce();
    expect(server.tool).toHaveBeenCalledWith(
      "cancel-operation",
      expect.any(String),
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("returns error for unknown operationId", async () => {
    const { server, getHandler } = createMockServer();
    registerCancelOperation(server);
    const handler = getHandler("cancel-operation");
    const result = (await handler({ operationId: "op_does_not_exist" })) as { isError: boolean; content: [{ text: string }] };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  it("cancels a running operation and returns cancelled status", async () => {
    vi.useFakeTimers();
    const { server, getHandler } = createMockServer();
    registerCancelOperation(server);
    const handler = getHandler("cancel-operation");

    const { operationId, signal } = operationRegistry.create("restart-instance");
    expect(signal.aborted).toBe(false);

    const handlerPromise = handler({ operationId });
    await vi.runAllTimersAsync();
    const result = (await handlerPromise) as { content: [{ text: string }] };
    const parsed = JSON.parse(result.content[0].text) as { status: string };
    expect(parsed.status).toBe("cancelled");
    expect(signal.aborted).toBe(true);
    vi.useRealTimers();
  });

  it("returns note when operation is already completed", async () => {
    const { server, getHandler } = createMockServer();
    registerCancelOperation(server);
    const handler = getHandler("cancel-operation");

    const { operationId } = operationRegistry.create("stop-instance");
    operationRegistry.succeed(operationId, { done: true });

    const result = (await handler({ operationId })) as { content: [{ text: string }] };
    const parsed = JSON.parse(result.content[0].text) as { note: string; status: string };
    expect(parsed.status).toBe("succeeded");
    expect(parsed.note).toContain("already succeeded");
  });

  it("includes postCancelInstances in response", async () => {
    vi.useFakeTimers();
    const { server, getHandler } = createMockServer();
    registerCancelOperation(server);
    const handler = getHandler("cancel-operation");

    mockedScan.mockResolvedValue([
      { accountId: 42, pid: 1234, cdpPort: 54321, connectable: true, helperChildCount: 0, source: "cmdline", confidence: "high" },
    ]);

    const { operationId } = operationRegistry.create("restart-instance");
    const handlerPromise = handler({ operationId });
    await vi.runAllTimersAsync();
    const result = (await handlerPromise) as { content: [{ text: string }] };
    const parsed = JSON.parse(result.content[0].text) as { postCancelInstances: unknown[] };
    expect(parsed.postCancelInstances).toHaveLength(1);
    expect(parsed.postCancelInstances[0]).toMatchObject({ accountId: 42, pid: 1234 });
    vi.useRealTimers();
  });
});
