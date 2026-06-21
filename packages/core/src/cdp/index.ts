// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

export { CDPClient } from "./client.js";
export { discoverTargets } from "./discovery.js";
export {
  discoverInstancePort,
  killInstanceProcesses,
} from "./instance-discovery.js";
export {
  findApp,
  resolveAppPort,
  resolveInstancePort,
  resolveLauncherPort,
  type AppRole,
  type DiscoveredApp,
} from "./app-discovery.js";
export {
  scanRunningInstances,
  scanOrphans,
  reapOrphans,
  type IdentitySource,
  type IdentityConfidence,
  type InstanceIdentity,
  type RunningInstance,
  type OrphanProcess,
} from "./process-inspector.js";
export {
  CDPConnectionError,
  CDPError,
  CDPEvaluationError,
  CDPTimeoutError,
} from "./errors.js";
