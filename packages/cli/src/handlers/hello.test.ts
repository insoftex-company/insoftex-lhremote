// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleHello } from "./hello.js";
import { getStdout } from "./testing/mock-helpers.js";

describe("handleHello", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints the version and where it runs from", () => {
    handleHello("9.9.9", {});

    const out = getStdout(stdoutSpy);
    expect(out).toContain("lhremote 9.9.9");
    expect(out).toMatch(/Running from: .*hello\.ts/);
    expect(out).toContain(`Node.js ${process.version}`);
  });

  it("prints JSON with --json", () => {
    handleHello("9.9.9", { json: true });

    expect(JSON.parse(getStdout(stdoutSpy))).toMatchObject({ name: "lhremote", version: "9.9.9" });
  });
});
