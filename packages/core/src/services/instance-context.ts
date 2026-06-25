// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { DatabaseClient, type DatabaseClientOptions, discoverDatabase } from "../db/index.js";
import { discoverInstancePort, findApp, resolveAppPort, scanRunningInstances } from "../cdp/index.js";
import type { UIHealthStatus } from "../types/index.js";
import { isCdpPort } from "../utils/cdp-port.js";
import { InstanceService } from "./instance.js";
import { LauncherService } from "./launcher.js";
import { InstanceNotRunningError, UIBlockedError } from "./errors.js";

/**
 * Resources available when only database access is needed.
 */
export interface DatabaseContext {
  readonly accountId: number;
  readonly db: DatabaseClient;
}

/**
 * Resources available when both instance (CDP) and database access are needed.
 */
export interface InstanceDatabaseContext {
  readonly accountId: number;
  readonly instance: InstanceService;
  readonly db: DatabaseClient;
}

/**
 * Open the account's database inside a managed scope.
 *
 * The database is automatically closed when the callback finishes
 * (whether it resolves or rejects).
 */
export async function withDatabase<T>(
  accountId: number,
  callback: (ctx: DatabaseContext) => T | Promise<T>,
  options?: DatabaseClientOptions,
): Promise<T> {
  const dbPath = discoverDatabase(accountId);
  const db = new DatabaseClient(dbPath, options);
  try {
    return await callback({ accountId, db });
  } finally {
    db.close();
  }
}

/**
 * Discover the running instance, connect to it, open the account's
 * database, and hand both to the callback.
 *
 * All resources are cleaned up automatically when the callback finishes.
 *
 * When {@link cdpPort} is omitted, the instance port is auto-discovered
 * via {@link resolveAppPort}.  When the provided port is an instance
 * port (rather than a launcher port), it is used directly.
 *
 * A launcher connection is opened alongside the instance so that
 * post-evaluation UI health checks can detect blocking dialogs and
 * popups.  If the launcher connection fails the operation proceeds
 * without health checking.
 *
 * @throws {InstanceNotRunningError} if no instance port can be discovered.
 */
export async function withInstanceDatabase<T>(
  cdpPort: number | undefined,
  accountId: number,
  callback: (ctx: InstanceDatabaseContext) => T | Promise<T>,
  options?: {
    instanceTimeout?: number;
    db?: DatabaseClientOptions;
    launcher?: { host?: string; allowRemote?: boolean };
  },
): Promise<T> {
  const { instancePort, launcherPort } = await resolveInstancePort(cdpPort, accountId);

  const instance = new InstanceService(
    instancePort,
    options?.instanceTimeout != null ? { timeout: options.instanceTimeout } : undefined,
  );
  let launcher: LauncherService | null = null;
  let db: DatabaseClient | null = null;

  try {
    await instance.connect();

    // Open a launcher connection for health checking.
    if (launcherPort !== null) {
      try {
        launcher = new LauncherService(launcherPort, options?.launcher);
        await launcher.connect();
        const connectedLauncher = launcher;
        instance.setHealthChecker(async () => {
          const [launcherHealth, instancePopups] = await Promise.all([
            connectedLauncher.checkUIHealth(accountId),
            instance.getInstancePopups(),
          ]);
          const health: UIHealthStatus = {
            ...launcherHealth,
            instancePopups: [...launcherHealth.instancePopups, ...instancePopups],
            healthy: launcherHealth.healthy && instancePopups.length === 0,
          };
          if (!health.healthy) {
            throw new UIBlockedError(health);
          }
        });
      } catch {
        // Launcher connection failed — proceed without health checking.
        launcher?.disconnect();
        launcher = null;
      }
    }

    const dbPath = discoverDatabase(accountId);
    db = new DatabaseClient(dbPath, options?.db);
    return await callback({ accountId, instance, db });
  } finally {
    instance.setHealthChecker(null);
    instance.disconnect();
    launcher?.disconnect();
    db?.close();
  }
}

/**
 * Resolve the instance and launcher ports from the provided cdpPort.
 *
 * When cdpPort is undefined and accountId is given, scans running instances
 * and returns the port for the specific account (account-aware auto-discovery).
 * When cdpPort is undefined and no accountId, falls back to the first
 * connectable instance via {@link resolveAppPort}.
 * When cdpPort is a launcher port, discovers instance from its children.
 * When cdpPort is an instance port, uses it directly.
 */
async function resolveInstancePort(
  cdpPort: number | undefined,
  accountId?: number,
): Promise<{ instancePort: number; launcherPort: number | null }> {
  // Auto-discover when no port provided
  if (cdpPort === undefined) {
    // Account-aware path: find the specific account's running instance.
    // This is essential when multiple instances are running simultaneously —
    // resolveAppPort("instance") returns the first connectable instance which
    // may belong to a different account.
    if (accountId !== undefined) {
      const instances = await scanRunningInstances();
      const match = instances.find(
        (i) => i.accountId === accountId && i.connectable && i.cdpPort !== null,
      );
      if (match?.cdpPort !== null && match?.cdpPort !== undefined) {
        let launcherPort: number | null = null;
        try {
          launcherPort = await resolveAppPort("launcher", 0);
        } catch {
          // Launcher not available — proceed without it
        }
        return { instancePort: match.cdpPort, launcherPort };
      }
      if (instances.length > 0) {
        // Other accounts are running but not this one.
        throw new InstanceNotRunningError(
          `Account ${String(accountId)} instance is not running. Use start-instance first.`,
        );
      }
      // No instances at all — fall through to resolveAppPort which throws a
      // richer LinkedHelperNotRunningError / LinkedHelperUnreachableError.
    }
    const instancePort = await resolveAppPort("instance");
    // Try to find a launcher port for health checking
    let launcherPort: number | null = null;
    try {
      launcherPort = await resolveAppPort("launcher", 0);
    } catch {
      // Launcher not available — proceed without it
    }
    return { instancePort, launcherPort };
  }

  // Fast path: classify the supplied port via findApp() before running
  // launcher-child discovery.  When the port is already recognized as a
  // connectable instance port (the common case for explicit caller-supplied
  // ports), return immediately — no launcher-child traversal needed.
  let launcherPort: number | null = null;
  try {
    const apps = await findApp();
    const instanceMatch = apps.find(
      (a) => a.cdpPort === cdpPort && a.role === "instance" && a.connectable,
    );
    if (instanceMatch) {
      const launcherApp = apps.find(
        (a) => a.role === "launcher" && a.connectable && a.cdpPort !== null,
      );
      return { instancePort: cdpPort, launcherPort: launcherApp?.cdpPort ?? null };
    }
    // Not an instance port — capture launcher port for later rejection guard.
    const launcherApp = apps.find(
      (a) => a.role === "launcher" && a.connectable && a.cdpPort !== null,
    );
    launcherPort = launcherApp?.cdpPort ?? null;
  } catch {
    // findApp() failed — proceed with other strategies
  }

  // Fallback: treat the supplied port as a launcher port and discover the
  // account-instance child.  Handles the case where the caller passed the
  // launcher port explicitly (e.g. when auto-discovery is not available).
  const instancePort = await discoverInstancePort(cdpPort);
  if (instancePort !== null) {
    return { instancePort, launcherPort: cdpPort };
  }

  // Last resort: probe the port directly, but reject known launcher ports
  // to avoid connecting InstanceService to a launcher (which would fail
  // with a confusing error instead of InstanceNotRunningError).
  if (cdpPort !== launcherPort && await isCdpPort(cdpPort)) {
    return { instancePort: cdpPort, launcherPort };
  }

  throw new InstanceNotRunningError(
    "No LinkedHelper instance is running. Use start-instance first.",
  );
}
