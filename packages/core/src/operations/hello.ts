// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface HelloOutput {
  readonly name: "lhremote";
  /** Version of the front end (CLI or MCP server) answering; all packages are released together. */
  readonly version: string;
  /**
   * Real path of the module that answered, with symlinks and Windows junctions
   * resolved — shows which installed copy is actually running.
   */
  readonly modulePath: string;
  readonly node: string;
  readonly platform: string;
  readonly pid: number;
}

/**
 * Report which lhremote is running. Needs no LinkedHelper connection.
 *
 * The version is passed in by the front end rather than read here: the
 * esbuild bundle rebases `require` onto the bundle file, so a `package.json`
 * read from core would resolve to the wrong place there.
 *
 * @param version - The calling package's version.
 * @param moduleUrl - The calling module's `import.meta.url`.
 */
export function hello(version: string, moduleUrl: string): HelloOutput {
  let modulePath = moduleUrl;
  try {
    modulePath = fileURLToPath(moduleUrl);
    modulePath = realpathSync(modulePath);
  } catch {
    // Keep the best path we have; reporting must never fail.
  }
  return {
    name: "lhremote",
    version,
    modulePath,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    pid: process.pid,
  };
}
