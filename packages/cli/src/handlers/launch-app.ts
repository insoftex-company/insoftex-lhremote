// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { AppService, errorMessage } from "@lhremote/core";

/** Handle the {@link https://github.com/alexey-pelykh/lhremote#app-management | launch-app} CLI command. */
export async function handleLaunchApp(options?: { force?: boolean }): Promise<void> {
  const serviceOptions = {
    // Give LinkedHelper up to 10 seconds to start and become ready on the CDP port
    launchProbeDelay: 10000,
    ...(options?.force !== undefined && { force: options.force }),
  };
  const app = new AppService(undefined, serviceOptions);

  try {
    await app.launch();
  } catch (error) {
    const message = errorMessage(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `LinkedHelper launched on CDP port ${String(app.cdpPort)}\n`,
  );
}
