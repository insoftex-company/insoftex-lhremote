// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import {
  AccountResolutionError,
  BudgetExceededError,
  CampaignNotFoundError,
  errorMessage,
  LinkedHelperNotRunningError,
  LinkedHelperUnreachableError,
  UIBlockedError,
} from "@insoftex/lhremote-core";
import { z } from "zod";

type TextContent = { type: "text"; text: string };
type McpResult = { isError?: boolean; content: TextContent[] };

/**
 * Shared Zod schema fields for CDP connection parameters.
 *
 * Spread into every tool that connects to a LinkedHelper instance:
 * ```ts
 * { campaignId: z.number(), ...cdpConnectionSchema }
 * ```
 */
export const cdpConnectionSchema = {
  cdpPort: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("CDP port (auto-discovered from running LinkedHelper processes when omitted)"),
  cdpHost: z
    .string()
    .optional()
    .describe("CDP host (default: 127.0.0.1)"),
  allowRemote: z
    .boolean()
    .optional()
    .describe("SECURITY: Allow non-loopback CDP connections. Enables remote code execution on target host. Only use if network path is secured."),
  accountId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Explicit account ID. Bypasses automatic account resolution (required when multiple accounts are configured)."),
};

// Re-export from core so existing MCP tool files keep working.
export { buildCdpOptions } from "@insoftex/lhremote-core";

/**
 * Build an MCP error response from a plain message string.
 */
export function mcpError(text: string): McpResult {
  return {
    isError: true,
    content: [{ type: "text" as const, text }],
  };
}

/**
 * Build an MCP success response from a plain text or JSON payload.
 */
export function mcpSuccess(text: string): McpResult {
  return {
    content: [{ type: "text" as const, text }],
  };
}

/**
 * Map common infrastructure errors (launcher not running, account
 * resolution failures) and domain errors (campaign not found) to an
 * MCP error response.
 *
 * Returns `undefined` if the error is not a recognised error so the
 * caller can fall through to domain-specific handling.
 */
export function mapErrorToMcpResponse(error: unknown): McpResult | undefined {
  if (error instanceof LinkedHelperUnreachableError) {
    const pids = error.processes.map((p) => String(p.pid)).join(", ");
    const connectableInstances = error.processes.filter(
      (p) => p.role === "instance" && p.connectable && p.cdpPort !== null,
    );
    if (connectableInstances.length > 0) {
      return mcpError(
        `Launcher CDP not available (PID ${pids}). ` +
          "Instance(s) detected — instance-level operations work, " +
          "but launcher operations (list-accounts, start/stop-instance) are unavailable. " +
          "Relaunch LinkedHelper with --remote-debugging-port or use launch-app.",
      );
    }
    return mcpError(
      `LinkedHelper is running (PID ${pids}) but CDP is not reachable. ` +
        "Restart LinkedHelper or use launch-app with force: true.",
    );
  }
  if (error instanceof LinkedHelperNotRunningError) {
    return mcpError("LinkedHelper is not running. Use launch-app first.");
  }
  if (error instanceof AccountResolutionError) {
    return mcpError(error.message);
  }
  if (error instanceof CampaignNotFoundError) {
    return mcpError(
      `Campaign ${String(error.campaignId)} not found.`,
    );
  }
  if (error instanceof BudgetExceededError) {
    return mcpError(error.message);
  }
  if (error instanceof UIBlockedError) {
    return mcpError(
      `${error.message}\n\nUse the dismiss-errors tool to clear closable popups, then retry.\n\nUI Health:\n${JSON.stringify(error.health, null, 2)}`,
    );
  }
  return undefined;
}

/** Minimal subset of RequestHandlerExtra needed to forward progress notifications. */
interface ProgressCapableExtra {
  _meta?: { progressToken?: string | number | undefined };
  sendNotification: (notification: { method: "notifications/progress"; params: { progressToken: string | number; progress: number; message: string } }) => Promise<void>;
}

/**
 * Wraps a registry progress callback to also forward messages as MCP
 * notifications/progress when the caller supplied a progressToken.
 * If no progressToken is present, returns the original callback unchanged.
 */
export function wrapProgress(
  registryProgress: (message: string) => void,
  extra: ProgressCapableExtra | undefined,
): (message: string) => void {
  const token = extra?._meta?.progressToken;
  if (token === undefined || extra === undefined) return registryProgress;
  let seq = 0;
  return (message: string): void => {
    registryProgress(message);
    void extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken: token, progress: seq++, message },
    });
  };
}

/**
 * Map an arbitrary caught error to an MCP error response with a
 * contextual prefix (e.g. "Failed to create campaign").
 */
export function mcpCatchAll(error: unknown, prefix: string): McpResult {
  const mapped = mapErrorToMcpResponse(error);
  if (mapped) return mapped;

  const message = errorMessage(error);
  return mcpError(`${prefix}: ${message}`);
}
