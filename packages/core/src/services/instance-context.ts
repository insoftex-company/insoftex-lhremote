// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { DatabaseClient, type DatabaseClientOptions, discoverDatabase } from "../db/index.js";
import { resolveInstancePort as resolveAccountPort, resolveAppPort } from "../cdp/index.js";
import type { UIHealthStatus } from "../types/index.js";
import { InstanceService } from "./instance.js";
import { LauncherService } from "./launcher.js";
import { UIBlockedError } from "./errors.js";

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
 * Each post-evaluation UI health check opens and releases a serialized
 * launcher session. If discovery cannot find a launcher, instance-only
 * operations remain available. Launcher connection failures are best-effort;
 * instance popups and connected-launcher health failures are still checked.
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
  let db: DatabaseClient | null = null;

  try {
    await instance.connect();

    if (launcherPort !== null) {
      instance.setHealthChecker(async () => {
        const launcher = new LauncherService(launcherPort, options?.launcher);
        let launcherHealth: UIHealthStatus = { healthy: true, issues: [], popup: null, instancePopups: [] };
        let connected = false;
        try {
          await launcher.connect();
          connected = true;
          launcherHealth = await launcher.checkUIHealth(accountId);
        } catch (error) {
          if (connected) throw error;
          // Preserve instance-only operation during launcher CDP recovery.
        } finally {
          launcher.disconnect();
        }
        const instancePopups = await instance.getInstancePopups();
        const health: UIHealthStatus = {
          ...launcherHealth,
          instancePopups: [...launcherHealth.instancePopups, ...instancePopups],
          healthy: launcherHealth.healthy && instancePopups.length === 0,
        };
        if (!health.healthy) throw new UIBlockedError(health);
      });
    }

    const dbPath = discoverDatabase(accountId);
    db = new DatabaseClient(dbPath, options?.db);
    return await callback({ accountId, instance, db });
  } finally {
    instance.setHealthChecker(null);
    instance.disconnect();
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
  accountId: number,
): Promise<{ instancePort: number; launcherPort: number | null }> {
  const instancePort = await resolveAccountPort(cdpPort, undefined, undefined, accountId);
  let launcherPort: number | null = null;
  try {
    launcherPort = await resolveAppPort("launcher", 0);
  } catch {
    // Instance operations remain usable when the launcher is unavailable.
  }
  return { instancePort, launcherPort };
}
