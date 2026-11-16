// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { hello } from "./hello.js";

describe("hello", () => {
  it("reports the given version and the runtime", () => {
    const result = hello("1.2.3", import.meta.url);

    expect(result.name).toBe("lhremote");
    expect(result.version).toBe("1.2.3");
    expect(result.node).toBe(process.version);
    expect(result.platform).toBe(`${process.platform}-${process.arch}`);
    expect(result.pid).toBe(process.pid);
    expect(result.modulePath).toMatch(/hello\.test\.ts$/);
  });

  // Creating symlinks on Windows needs elevated rights or developer mode.
  it.skipIf(process.platform === "win32")("resolves symlinks to the real module path", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "lhremote-hello-")));
    try {
      const real = join(dir, "real.js");
      const link = join(dir, "link.js");
      writeFileSync(real, "");
      symlinkSync(real, link);

      expect(hello("1.0.0", pathToFileURL(link).href).modulePath).toBe(real);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the given url when it is not a file url", () => {
    expect(hello("1.0.0", "bundle://x").modulePath).toBe("bundle://x");
  });
});
