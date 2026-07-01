// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { readFileSync } from "node:fs";

/** Parse a comma-separated `--urls` option value into a trimmed, non-empty list. */
export function parseUrls(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Read a `--urls-file` option value: newline- or comma-separated URLs, one per line. */
export function readUrlsFile(filePath: string): string[] {
  const content = readFileSync(filePath, "utf-8");
  return content
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
