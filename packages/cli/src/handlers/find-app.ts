// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { errorMessage, findApp, probePidPorts, type PortProbe } from "@insoftex/lhremote-core";

/** Write the per-port probe lines for one PID (`null` = enumeration failed). */
function writePortProbes(probes: PortProbe[] | null): void {
  if (probes === null) {
    process.stdout.write("  failed to enumerate listening ports\n");
    return;
  }
  if (probes.length === 0) {
    process.stdout.write("  no listening TCP ports\n");
    return;
  }
  for (const { port, cdp } of probes) {
    process.stdout.write(`  port ${String(port)} — ${cdp ? "CDP" : "not CDP"}\n`);
  }
}

/** Handle the {@link https://github.com/insoftex-company/insoftex-lhremote#app-management | find-app} CLI command. */
export async function handleFindApp(options: {
  json?: boolean;
  verbose?: boolean;
  /** `true` when `--ports` is passed bare; a PID when `--ports <pid>` is passed. */
  ports?: number | boolean;
}): Promise<void> {
  try {
    const apps = await findApp(options.verbose ? { includeHelpers: true } : {});

    // --ports: enumerate listening TCP ports and probe each for CDP.
    // Bare flag covers every discovered non-helper process; an explicit PID
    // covers just that PID (LinkedHelper or not — it's a diagnostic).
    const portProbes = new Map<number, PortProbe[] | null>();
    if (options.ports !== undefined && options.ports !== false) {
      const pids =
        typeof options.ports === "number"
          ? [options.ports]
          : apps.filter((a) => a.role !== "helper-child").map((a) => a.pid);
      for (const pid of pids) {
        try {
          portProbes.set(pid, await probePidPorts(pid));
        } catch {
          portProbes.set(pid, null);
        }
      }
    }

    const explicitPid = typeof options.ports === "number" ? options.ports : null;
    const explicitPidIsForeign =
      explicitPid !== null && !apps.some((a) => a.pid === explicitPid);

    if (options.json) {
      const augmented: unknown[] = apps.map((app) =>
        portProbes.has(app.pid) ? { ...app, ports: portProbes.get(app.pid) } : app,
      );
      if (explicitPidIsForeign) {
        augmented.push({ pid: explicitPid, ports: portProbes.get(explicitPid) });
      }
      process.stdout.write(JSON.stringify(augmented, null, 2) + "\n");
      return;
    }

    if (apps.length === 0) {
      process.stdout.write("No running LinkedHelper instances found\n");
      if (!explicitPidIsForeign) return;
    }

    for (const app of apps) {
      const port =
        app.cdpPort !== null ? `CDP port ${String(app.cdpPort)}` : "no CDP port";
      const status = app.connectable ? "connectable" : "not connectable";
      process.stdout.write(
        `PID ${String(app.pid)} — ${port} — ${status} — ${app.role}\n`,
      );
      if (options.verbose) {
        process.stdout.write(JSON.stringify(app, null, 2) + "\n");
      }
      const probes = portProbes.get(app.pid);
      if (probes !== undefined) {
        writePortProbes(probes);
      }
    }

    if (explicitPidIsForeign) {
      process.stdout.write(
        `PID ${String(explicitPid)} — not a LinkedHelper process\n`,
      );
      writePortProbes(portProbes.get(explicitPid) ?? null);
    }
  } catch (error) {
    const message = errorMessage(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
