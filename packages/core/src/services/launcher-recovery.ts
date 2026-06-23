// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { CDPConnectionError, resolveLauncherPort } from "../cdp/index.js";
import { LinkedHelperUnreachableError } from "./errors.js";
import { DEFAULT_LAUNCHER_RECOVERY_TIMEOUT_MS, LauncherService } from "./launcher.js";

// Re-export so consumers can import everything from launcher-recovery.
export { DEFAULT_LAUNCHER_RECOVERY_TIMEOUT_MS } from "./launcher.js";

/**
 * Options for {@link withLauncherRecovery}.
 */
export interface LauncherRecoveryOptions {
  /**
   * Maximum time in milliseconds to spend re-discovering and reconnecting to
   * the launcher CDP after a connection error.  Defaults to
   * {@link DEFAULT_LAUNCHER_RECOVERY_TIMEOUT_MS} (60 000 ms).
   *
   * Can also be set globally via `LHREMOTE_LAUNCHER_RECOVERY_TIMEOUT_MS`.
   */
  timeoutMs?: number;
  /**
   * Optional cancellation signal.  When fired, ongoing recovery retries are
   * interrupted and the error propagates to the caller.
   */
  signal?: AbortSignal;
}

/**
 * Return type of {@link withLauncherRecovery}.
 */
export interface LauncherRecoveryResult<T> {
  /** The value returned by the operation. */
  result: T;
  /**
   * `true` when the launcher CDP connection was lost and automatically
   * recovered before the operation completed.
   */
  launcherRecovered: boolean;
}

function isLauncherConnectionError(error: unknown): boolean {
  return (
    error instanceof CDPConnectionError ||
    error instanceof LinkedHelperUnreachableError
  );
}

/**
 * Run a launcher-dependent operation with automatic CDP recovery.
 *
 * Tries `op()` once.  If it throws a {@link CDPConnectionError} or
 * {@link LinkedHelperUnreachableError} the launcher's current debugging port
 * is re-discovered via OS process inspection (the port is dynamic — never
 * assumed to be 9222), the launcher is reconnected with exponential back-off,
 * and `op()` is retried once against the recovered connection.
 *
 * Recovery time is capped at `options.timeoutMs`
 * (default {@link DEFAULT_LAUNCHER_RECOVERY_TIMEOUT_MS}, 60 s), also
 * configurable via `LHREMOTE_LAUNCHER_RECOVERY_TIMEOUT_MS`.
 *
 * On permanent failure (cap exceeded), the underlying error propagates so
 * callers can surface a structured {@link LinkedHelperUnreachableError}
 * rather than a raw exception.
 *
 * @param launcher - A connected (or recently-failed) {@link LauncherService}.
 * @param op       - The operation to run.  Captures `launcher` from the outer
 *   scope; called with no arguments on both the first try and the retry.
 * @param options  - Recovery options.
 *
 * @example
 * ```ts
 * const { result: accounts, launcherRecovered } = await withLauncherRecovery(
 *   launcher,
 *   () => launcher.listAccounts(),
 * );
 * ```
 */
export async function withLauncherRecovery<T>(
  launcher: LauncherService,
  op: () => Promise<T>,
  options?: LauncherRecoveryOptions,
): Promise<LauncherRecoveryResult<T>> {
  // Fast path: no connection error, return immediately.
  try {
    const result = await op();
    return { result, launcherRecovered: false };
  } catch (error) {
    if (!isLauncherConnectionError(error)) {
      throw error;
    }
  }

  // Bail early if cancelled before attempting recovery.
  options?.signal?.throwIfAborted?.();

  // Connection error detected — attempt recovery.
  const timeoutMs =
    options?.timeoutMs ??
    (process.env["LHREMOTE_LAUNCHER_RECOVERY_TIMEOUT_MS"]
      ? Number(process.env["LHREMOTE_LAUNCHER_RECOVERY_TIMEOUT_MS"])
      : DEFAULT_LAUNCHER_RECOVERY_TIMEOUT_MS);

  // reconnect() re-discovers the current port via OS process inspection,
  // retries with back-off, and throws LinkedHelperUnreachableError on cap.
  await launcher.reconnect({ timeoutMs, ...(options?.signal !== undefined ? { signal: options.signal } : {}) });

  options?.signal?.throwIfAborted?.();

  const result = await op();
  return { result, launcherRecovered: true };
}

// ---------------------------------------------------------------------------
// Launcher acquisition with recovery
// ---------------------------------------------------------------------------

/**
 * Result of {@link acquireLauncherWithRecovery}.
 */
export interface AcquireLauncherResult {
  /** Connected launcher service. Call `.disconnect()` when done. */
  launcher: LauncherService;
  /**
   * `true` when the initial {@link LauncherService.connect} failed and the
   * connection was re-established via {@link LauncherService.reconnect}.
   * The launcher may be listening on a different port than originally
   * discovered; use {@link LauncherService.currentPort} to get the live port.
   */
  launcherPreRecovered: boolean;
}

/**
 * Discover, connect to, and return a {@link LauncherService} with automatic
 * CDP recovery on both the port-resolution and connect steps.
 *
 * The launcher briefly drops its CDP port when it reconciles running
 * instances after a write op.  This window can cause either
 * `resolveLauncherPort` (port not yet re-bound) or `connect()` (port found
 * but socket not yet accepting) to fail with `LinkedHelperUnreachableError`.
 *
 * To cover both failure points, the initial `resolveLauncherPort` call uses a
 * zero retry-timeout (fast-fail, one scan).  Any `LinkedHelperUnreachableError`
 * from either resolve or connect is treated identically: `reconnect()` is
 * called, which re-discovers the launcher's current port via OS process
 * inspection and retries with back-off up to `recoveryOptions.timeoutMs`
 * (default {@link DEFAULT_LAUNCHER_RECOVERY_TIMEOUT_MS}, 60 s).
 *
 * `LinkedHelperNotRunningError` (no launcher process at all) propagates
 * immediately — no recovery is attempted.
 *
 * @param cdpPort        - Explicit launcher CDP port, or `undefined` for auto-discovery.
 * @param cdpOptions     - CDP connection options (`host`, `allowRemote`).
 * @param recoveryOptions - Optional recovery timeout override.
 *
 * @throws {LinkedHelperNotRunningError}  when no launcher process is found.
 * @throws {LinkedHelperUnreachableError} when the launcher remains unreachable
 *   after the recovery cap is exceeded.
 */
export async function acquireLauncherWithRecovery(
  cdpPort: number | undefined,
  cdpOptions: { host?: string; allowRemote?: boolean } = {},
  recoveryOptions?: LauncherRecoveryOptions,
): Promise<AcquireLauncherResult> {
  // Fast-path: resolve port with a single scan (no retry) then connect.
  // A `LinkedHelperUnreachableError` here means the launcher is mid-hop;
  // we treat it identically to a connect-time failure and fall to reconnect().
  let resolvedPort: number | undefined;
  let fastPathFailed = false;

  recoveryOptions?.signal?.throwIfAborted?.();

  try {
    resolvedPort = await resolveLauncherPort(cdpPort, cdpOptions.host, 0);
  } catch (err) {
    if (!(err instanceof LinkedHelperUnreachableError)) {
      throw err; // LinkedHelperNotRunningError or unexpected error — propagate
    }
    fastPathFailed = true;
  }

  // Create the service with whatever port we have; reconnect() overwrites it.
  const launcher = new LauncherService(resolvedPort ?? (cdpPort ?? 0), cdpOptions);

  if (!fastPathFailed) {
    recoveryOptions?.signal?.throwIfAborted?.();
    try {
      await launcher.connect();
      return { launcher, launcherPreRecovered: false };
    } catch (error) {
      if (!isLauncherConnectionError(error)) {
        throw error;
      }
      // Port resolved but connect failed — launcher may have moved to a new
      // port mid-flight. Fall through to reconnect().
    }
  }

  // Recovery: reconnect() re-discovers the current port via OS process
  // inspection (fresh per-attempt, never pinned to a stale port) and retries
  // with back-off up to the configured budget.
  await launcher.reconnect(recoveryOptions);
  return { launcher, launcherPreRecovered: true };
}
