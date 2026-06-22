// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import {
  type Account,
  errorMessage,
  LauncherService,
  resolveAppPort,
  waitForInstanceShutdown,
  withLauncherQueue,
  withLauncherRecovery,
} from "@insoftex/lhremote-core";

/** Handle the {@link https://github.com/insoftex-company/insoftex-lhremote#account--instance | stop-instance} CLI command. */
export async function handleStopInstance(
  accountIdArg: string | undefined,
  options: { cdpPort?: number; cdpHost?: string; allowRemote?: boolean },
): Promise<void> {
  let cdpPort: number;
  try {
    cdpPort = options.cdpPort ?? await resolveAppPort("launcher");
  } catch (error) {
    const message = errorMessage(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
    return;
  }

  const launcher = new LauncherService(cdpPort, {
    ...(options.cdpHost !== undefined && { host: options.cdpHost }),
    ...(options.allowRemote !== undefined && { allowRemote: options.allowRemote }),
  });

  try {
    await launcher.connect();
  } catch (error) {
    const message = errorMessage(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
    return;
  }

  try {
    let accountId = accountIdArg === undefined ? undefined : Number(accountIdArg);

    if (accountId === undefined) {
      const { result: accounts } = await withLauncherRecovery(
        launcher,
        () => launcher.listAccounts(),
      );

      if (accounts.length === 0) {
        process.stderr.write("No accounts found.\n");
        process.exitCode = 1;
        return;
      }
      if (accounts.length > 1) {
        process.stderr.write(
          "Multiple accounts found. Specify accountId. Use list-accounts to see available accounts.\n",
        );
        process.exitCode = 1;
        return;
      }
      accountId = (accounts[0] as Account).id;
    }

    await withLauncherQueue(
      () =>
        withLauncherRecovery(
          launcher,
          async () => {
            await launcher.stopInstance(accountId as number);
            await waitForInstanceShutdown(cdpPort);
          },
        ),
      { type: "stop", launcherPort: cdpPort },
    );

    process.stdout.write(
      `Instance stopped for account ${String(accountId)}\n`,
    );
  } catch (error) {
    const message = errorMessage(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  } finally {
    launcher.disconnect();
  }
}
