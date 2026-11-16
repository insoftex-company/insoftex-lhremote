// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { hello } from "@insoftex/lhremote-core";

/** Handle the {@link https://github.com/insoftex-company/insoftex-lhremote#hello | hello} CLI command. */
export function handleHello(version: string, options: { json?: boolean }): void {
  const report = hello(version, import.meta.url);

  if (options.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }

  process.stdout.write(
    `lhremote ${report.version}\n` +
      `Running from: ${report.modulePath}\n` +
      `Node.js ${report.node} on ${report.platform} (pid ${String(report.pid)})\n`,
  );
}
