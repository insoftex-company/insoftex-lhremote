// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, describe, expect, it } from "vitest";
import { withLauncherCDPGate } from "./launcher-cdp-gate.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("withLauncherCDPGate", () => {
  afterEach(() => {
    // The gate is a module-level promise chain.  Tests that end cleanly always
    // resolve it in the finally block, so no state leaks between tests.
  });

  it("returns the value from op", async () => {
    const result = await withLauncherCDPGate(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it("runs a single op and resolves", async () => {
    let ran = false;
    await withLauncherCDPGate(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("serializes two concurrent calls — no overlap", async () => {
    const log: string[] = [];
    let op1Done = false;

    const op1 = withLauncherCDPGate(async () => {
      log.push("op1:start");
      await new Promise<void>((r) => setTimeout(r, 20));
      op1Done = true;
      log.push("op1:end");
    });

    const op2 = withLauncherCDPGate(async () => {
      log.push("op2:start");
      expect(op1Done).toBe(true); // op1 must have finished before op2 starts
      log.push("op2:end");
    });

    await Promise.all([op1, op2]);
    expect(log).toEqual(["op1:start", "op1:end", "op2:start", "op2:end"]);
  });

  it("serializes three concurrent calls in submission order", async () => {
    const log: string[] = [];

    const ops = [0, 1, 2].map((i) =>
      withLauncherCDPGate(async () => {
        log.push(`op${i}`);
      }),
    );

    await Promise.all(ops);
    expect(log).toEqual(["op0", "op1", "op2"]);
  });

  it("releases the gate even when op throws", async () => {
    await withLauncherCDPGate(() => Promise.reject(new Error("fail"))).catch(() => {});

    // A subsequent op must still run — the gate was released.
    const result = await withLauncherCDPGate(() => Promise.resolve("recovered"));
    expect(result).toBe("recovered");
  });

  it("deadlock guard: read op and two-phase write op interleave without blocking", async () => {
    // Models restart-instance: a write op acquires the gate twice (stop + start)
    // with a release in between. A read op (list-accounts) fills the gap.
    // None must block indefinitely.
    const log: string[] = [];

    // Write op — stop phase (holds gate first)
    const writeStop = withLauncherCDPGate(async () => {
      log.push("write:stop");
      // Simulate brief RPC duration
      await new Promise<void>((r) => setTimeout(r, 10));
    });

    // Read op — concurrent with write
    const read = withLauncherCDPGate(async () => {
      log.push("read");
    });

    // Write op — start phase (after stop releases the gate)
    const writeStart = writeStop.then(() =>
      withLauncherCDPGate(async () => {
        log.push("write:start");
      }),
    );

    await Promise.all([writeStop, read, writeStart]);

    // write:stop is always first.
    // read and write:start both wait for write:stop; JS schedules them in
    // submission order, so read runs before write:start.
    expect(log[0]).toBe("write:stop");
    expect(log).toContain("read");
    expect(log).toContain("write:start");
    // The key invariant: no two ops overlap (exactly 3 sequential entries).
    expect(log).toHaveLength(3);
    // write:start is always last (registered after write:stop resolved).
    expect(log[2]).toBe("write:start");
  });
});
