// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import {
  type Account,
  errorMessage,
  LauncherService,
  resolveAppPort,
  startInstanceWithRecovery,
  withLauncherQueue,
  withLauncherRecovery,
} from "@insoftex/lhremote-core";

/** Handle the {@link https://github.com/insoftex-company/insoftex-lhremote#account--instance | start-instance} CLI command. */
export async function handleStartInstance(
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

    const { result: outcome } = await withLauncherQueue(
      () =>
        withLauncherRecovery(
          launcher,
          () => startInstanceWithRecovery(launcher, accountId as number, cdpPort),
        ),
      { type: "start", accountId: accountId as number, launcherPort: cdpPort },
    );

    if (outcome.status === "timeout") {
      process.stderr.write(
        "Instance started but failed to initialize within timeout.\n",
      );
      process.exitCode = 1;
      return;
    }

    const verb =
      outcome.status === "already_running"
        ? "already running"
        : "started";

    process.stdout.write(
      `Instance ${verb} for account ${String(accountId)} on CDP port ${String(outcome.port)}\n`,
    );
  } catch (error) {
    const message = errorMessage(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  } finally {
    launcher.disconnect();
  }
}
