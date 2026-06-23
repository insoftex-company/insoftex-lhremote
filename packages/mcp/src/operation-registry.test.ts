// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FAST_PATH_GRACE_MS,
  OperationRegistry,
  runAsyncOp,
} from "./operation-registry.js";

// ---------------------------------------------------------------------------
// OperationRegistry
// ---------------------------------------------------------------------------

describe("OperationRegistry", () => {
  let registry: OperationRegistry;

  beforeEach(() => {
    registry = new OperationRegistry();
  });

  it("create() returns a running record with an AbortSignal", () => {
    const { operationId, signal } = registry.create("restart-instance");

    expect(operationId).toMatch(/^op_[0-9a-f]{16}$/);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);

    const record = registry.get(operationId);
    expect(record).toBeDefined();
    expect(record?.kind).toBe("restart-instance");
    expect(record?.status).toBe("running");
  });

  it("get() returns undefined for an unknown id", () => {
    expect(registry.get("op_nope")).toBeUndefined();
  });

  it("succeed() transitions status and stores result", () => {
    const { operationId } = registry.create("start-instance");
    registry.succeed(operationId, { port: 55001 });

    const record = registry.get(operationId);
    expect(record?.status).toBe("succeeded");
    expect(record?.result).toEqual({ port: 55001 });
    expect(record?.finishedAt).toBeDefined();
  });

  it("fail() transitions status and stores error string", () => {
    const { operationId } = registry.create("stop-instance");
    registry.fail(operationId, new Error("CDP lost"));

    const record = registry.get(operationId);
    expect(record?.status).toBe("failed");
    expect(record?.error).toBe("CDP lost");
    expect(record?.finishedAt).toBeDefined();
  });

  it("fail() stringifies non-Error thrown values", () => {
    const { operationId } = registry.create("stop-instance");
    registry.fail(operationId, "plain string error");

    expect(registry.get(operationId)?.error).toBe("plain string error");
  });

  it("cancel() fires the AbortSignal and transitions status", () => {
    const { operationId, signal } = registry.create("ensure-instances");

    const cancelled = registry.cancel(operationId);

    expect(cancelled).toBe(true);
    expect(signal.aborted).toBe(true);
    const record = registry.get(operationId);
    expect(record?.status).toBe("cancelled");
    expect(record?.finishedAt).toBeDefined();
  });

  it("cancel() returns false for unknown id", () => {
    expect(registry.cancel("op_unknown")).toBe(false);
  });

  it("cancel() returns false when operation is not running", () => {
    const { operationId } = registry.create("launch-app");
    registry.succeed(operationId, null);
    expect(registry.cancel(operationId)).toBe(false);
  });

  it("getActiveWriteOp() returns the running operation", () => {
    const { operationId } = registry.create("restart-instance");

    const active = registry.getActiveWriteOp();
    expect(active?.operationId).toBe(operationId);
    expect(active?.status).toBe("running");
  });

  it("getActiveWriteOp() returns undefined when no op is running", () => {
    const { operationId } = registry.create("restart-instance");
    registry.succeed(operationId, null);

    expect(registry.getActiveWriteOp()).toBeUndefined();
  });

  it("list() returns all records without abortController", () => {
    const { operationId: id1 } = registry.create("start-instance");
    registry.succeed(id1, null);
    const { operationId: id2 } = registry.create("stop-instance");

    const records = registry.list();
    expect(records).toHaveLength(2);
    for (const r of records) {
      expect(r).not.toHaveProperty("abortController");
    }
    const ids = records.map((r) => r.operationId);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
  });

  it("progress() messages appear in the record", () => {
    const { operationId, progress } = registry.create("ensure-instances");
    progress("step 1");
    progress("step 2");

    const record = registry.get(operationId);
    expect(record?.progress).toHaveLength(2);
    expect(record?.progress[0]?.message).toBe("step 1");
    expect(record?.progress[1]?.message).toBe("step 2");
    expect(record?.progress[0]?.at).toMatch(/^\d{4}-/);
  });

  it("progress() is silently ignored after operation finishes", () => {
    const { operationId, progress } = registry.create("quit-app");
    registry.succeed(operationId, null);
    progress("too late");

    expect(registry.get(operationId)?.progress).toHaveLength(0);
  });

  it("create() does not expose abortController on the public record", () => {
    const { operationId } = registry.create("launch-app");
    const record = registry.get(operationId);
    expect(record).not.toHaveProperty("abortController");
  });
});

// ---------------------------------------------------------------------------
// runAsyncOp
// ---------------------------------------------------------------------------

describe("runAsyncOp", () => {
  let registry: OperationRegistry;

  beforeEach(() => {
    registry = new OperationRegistry();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns completed synchronously when work finishes within grace window", async () => {
    const work = vi.fn().mockResolvedValue("fast-result");

    const promise = runAsyncOp(registry, "start-instance", work);
    // Advance past the grace window so the race resolves.
    await vi.runAllTimersAsync();
    const outcome = await promise;

    expect(outcome.status).toBe("completed");
    if (outcome.status === "completed") {
      expect(outcome.result).toBe("fast-result");
    }
  });

  it("returns in_progress when work exceeds the grace window", async () => {
    let resolveWork!: (v: string) => void;
    const work = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveWork = resolve;
        }),
    );

    const promise = runAsyncOp(registry, "restart-instance", work);
    // Advance past grace window without settling the work.
    await vi.advanceTimersByTimeAsync(FAST_PATH_GRACE_MS + 1);
    const outcome = await promise;

    expect(outcome.status).toBe("in_progress");
    if (outcome.status === "in_progress") {
      expect(outcome.operationId).toMatch(/^op_/);
      expect(outcome.kind).toBe("restart-instance");
    }

    // Settle the background work so vitest doesn't complain about hanging.
    resolveWork("done");
    await vi.runAllTimersAsync();
  });

  it("throws synchronously when fast work throws", async () => {
    const work = vi.fn((): Promise<never> => { throw new Error("fast-fail"); });

    const promise = runAsyncOp(registry, "stop-instance", work);
    // Attach the rejection handler BEFORE advancing timers so it is already
    // registered when the Promise rejects — avoids PromiseRejectionHandledWarning.
    const assertion = expect(promise).rejects.toThrow("fast-fail");
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("rejects with single-writer reason when an op is already running", async () => {
    // Start a slow op
    let resolveFirst!: () => void;
    runAsyncOp(
      registry,
      "restart-instance",
      () => new Promise<void>((r) => { resolveFirst = r; }),
    );
    await vi.advanceTimersByTimeAsync(FAST_PATH_GRACE_MS + 1);

    // Second op must be rejected immediately
    const secondWork = vi.fn().mockResolvedValue(null);
    const secondPromise = runAsyncOp(registry, "start-instance", secondWork);
    await vi.runAllTimersAsync();
    const outcome = await secondPromise;

    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
      expect(outcome.reason).toContain("restart-instance");
    }
    expect(secondWork).not.toHaveBeenCalled();

    // Clean up
    resolveFirst();
    await vi.runAllTimersAsync();
  });

  it("passes an AbortSignal to the work function", async () => {
    let capturedSignal!: AbortSignal;
    const work = vi.fn((signal: AbortSignal) => {
      capturedSignal = signal;
      return Promise.resolve("ok");
    });

    const promise = runAsyncOp(registry, "ensure-instances", work);
    await vi.runAllTimersAsync();
    await promise;

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
  });

  it("passes a progress function to the work function", async () => {
    let capturedProgress!: (msg: string) => void;
    const work = vi.fn((_signal: AbortSignal, progress: (msg: string) => void) => {
      capturedProgress = progress;
      return Promise.resolve("ok");
    });

    const promise = runAsyncOp(registry, "launch-app", work);
    await vi.runAllTimersAsync();
    await promise;

    expect(capturedProgress).toBeTypeOf("function");
  });

  it("background op records succeed() after the grace window", async () => {
    let resolveWork!: (v: string) => void;
    const work = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveWork = resolve;
        }),
    );

    const promise = runAsyncOp(registry, "restart-instance", work);
    await vi.advanceTimersByTimeAsync(FAST_PATH_GRACE_MS + 1);
    const outcome = await promise;

    expect(outcome.status).toBe("in_progress");
    const { operationId } = outcome as { operationId: string; status: "in_progress" };

    resolveWork("background-done");
    await vi.runAllTimersAsync();

    const record = registry.get(operationId);
    expect(record?.status).toBe("succeeded");
    expect(record?.result).toBe("background-done");
  });

  it("background op records fail() after the grace window", async () => {
    let rejectWork!: (e: Error) => void;
    const work = vi.fn(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectWork = reject;
        }),
    );

    const promise = runAsyncOp(registry, "stop-instance", work);
    await vi.advanceTimersByTimeAsync(FAST_PATH_GRACE_MS + 1);
    const outcome = await promise;

    expect(outcome.status).toBe("in_progress");
    const { operationId } = outcome as { operationId: string; status: "in_progress" };

    rejectWork(new Error("background-error"));
    await vi.runAllTimersAsync();

    const record = registry.get(operationId);
    expect(record?.status).toBe("failed");
    expect(record?.error).toBe("background-error");
  });

  it("external signal abort cancels the operation even when work throws a non-AbortError", async () => {
    // This simulates the MCP scenario: the client fires notifications/cancelled,
    // which aborts extra.signal (passed as options.signal). The work function's
    // aborted blocking call throws LinkedHelperUnreachableError (not AbortError).
    // The operation must land as "cancelled", not "failed".
    const externalController = new AbortController();
    let rejectWork!: (e: Error) => void;
    const work = vi.fn(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectWork = reject;
        }),
    );

    const promise = runAsyncOp(
      registry,
      "start-instance",
      work,
      { signal: externalController.signal },
    );
    await vi.advanceTimersByTimeAsync(FAST_PATH_GRACE_MS + 1);
    const outcome = await promise;

    expect(outcome.status).toBe("in_progress");
    const { operationId } = outcome as { operationId: string; status: "in_progress" };

    // Fire the external (MCP) signal, then the work throws a domain error.
    externalController.abort();
    rejectWork(new Error("LinkedHelperUnreachableError-style domain error"));
    await vi.runAllTimersAsync();

    const record = registry.get(operationId);
    expect(record?.status).toBe("cancelled");
  });

  it("work signals the merged signal receives both registry cancel and external abort", async () => {
    const externalController = new AbortController();
    let capturedSignal!: AbortSignal;
    let resolveWork!: () => void;
    const work = vi.fn((signal: AbortSignal) => {
      capturedSignal = signal;
      return new Promise<void>((resolve) => { resolveWork = resolve; });
    });

    const promise = runAsyncOp(registry, "stop-instance", work, { signal: externalController.signal });
    await vi.advanceTimersByTimeAsync(FAST_PATH_GRACE_MS + 1);
    const outcome = await promise;
    expect(outcome.status).toBe("in_progress");
    const { operationId } = outcome as { operationId: string; status: "in_progress" };

    expect(capturedSignal.aborted).toBe(false);

    // External abort fires the merged signal.
    externalController.abort();
    expect(capturedSignal.aborted).toBe(true);

    resolveWork();
    await vi.runAllTimersAsync();
    // Operation resolved normally after signal fired (work didn't throw).
    expect(registry.get(operationId)?.status).toBe("succeeded");
  });
});
