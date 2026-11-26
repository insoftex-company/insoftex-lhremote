// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Insoftex

/**
 * Runs at the end of `pnpm build`. On a Windows machine that has the
 * `~/scripts/lhremote` junction, deploys the build just made into a new
 * versioned snapshot and repoints the junction at it. Does nothing anywhere
 * else (macOS, Linux, CI, a Windows clone without the junction).
 *
 * `--install` (`pnpm install:windows`) is the first-time setup: it also copies
 * the `lhremote.cmd` / `lhremote.ps1` wrappers and creates the junction.
 *
 * It must run elevated: over SSH, Windows refuses to follow links that a
 * non-elevated process created ("untrusted mount point"), which surfaces as
 * `Cannot find module ...\scripts\lhremote\dist\cli.js`.
 *
 * Only a clean `main` is deployed. Set LHREMOTE_NO_DEPLOY=1 to skip.
 */

import { execFileSync, execSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptsDir = join(homedir(), "scripts");
const live = join(scriptsDir, "lhremote");
const install = process.argv.includes("--install");
// A '--prod' deploy records "production only" here, in the source clone, and the next
// pnpm script then tries to reinstall without devDependencies.
const workspaceState = join(repo, "node_modules", ".pnpm-workspace-state-v1.json");

const log = (message) => console.log(`[deploy-local] ${message}`);
const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const cliVersion = (dir) =>
  execFileSync(process.execPath, [join(dir, "dist", "cli.js"), "--version"], {
    encoding: "utf8",
  }).trim();

function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function readManifest(dir) {
  const file = join(dir, "DEPLOYMENT-INFO.json");
  if (!existsSync(file)) return undefined;
  try {
    // Hand-written manifests from PowerShell may start with a BOM.
    return JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch {
    return undefined;
  }
}

function repoint(target) {
  // rmdir on a junction removes the link only, never the folder it points to.
  if (isLink(live)) rmdirSync(live);
  symlinkSync(target, live, "junction");
}

function deploy(target) {
  const state = existsSync(workspaceState) ? readFileSync(workspaceState) : undefined;
  try {
    // 'copy' keeps a later build from rewriting files inside the live snapshot.
    execSync(
      // A config option rather than '--legacy', which pnpm 9 rejects.
      "pnpm --config.package-import-method=copy --config.force-legacy-deploy=true " +
        `--filter=@insoftex/lhremote deploy --prod "${target}"`,
      { cwd: repo, stdio: "inherit" },
    );
  } finally {
    if (state) writeFileSync(workspaceState, state);
  }
}

function installWrappers() {
  mkdirSync(scriptsDir, { recursive: true });
  for (const name of ["lhremote.cmd", "lhremote.ps1"]) {
    const destination = join(scriptsDir, name);
    if (existsSync(destination)) continue;
    copyFileSync(join(repo, "scripts", name), destination);
    log(`installed ${destination}`);
  }
}

function main() {
  if (process.platform !== "win32" || process.env.CI || process.env.LHREMOTE_NO_DEPLOY) {
    if (install) throw new Error("nothing installed: Windows only, outside CI.");
    return;
  }
  if (!isLink(live)) {
    if (!install) return;
    if (existsSync(live)) throw new Error(`${live} exists and is not a junction; move it first.`);
  }

  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== "main" || git(["status", "--porcelain"]) !== "") {
    const reason = `only a clean 'main' is deployed (branch '${branch}').`;
    if (install) throw new Error(`nothing installed: ${reason}`);
    log(`not deployed: ${reason}`);
    return;
  }

  if (spawnSync("fltmc", { stdio: "ignore" }).status !== 0) {
    throw new Error(
      "run 'pnpm build' from an elevated shell (Run as administrator, or over SSH). " +
        "A non-elevated deploy cannot be run over SSH. Set LHREMOTE_NO_DEPLOY=1 to only build.",
    );
  }

  const commit = git(["rev-parse", "HEAD"]);
  const { version } = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  if (install) installWrappers();
  const previous = isLink(live) ? resolve(readlinkSync(live)) : undefined;
  const current = previous && readManifest(previous);
  if (current?.commit === commit && current?.deployedBy === "deploy-local") {
    log(`already deployed: ${version} (${commit.slice(0, 7)}).`);
    return;
  }

  let target = join(scriptsDir, `lhremote-${version}-${commit.slice(0, 7)}`);
  if (existsSync(target)) target += `-${Date.now()}`;

  log(`deploying ${version} (${commit.slice(0, 7)}) to ${target}`);
  deploy(target);

  const built = cliVersion(target);
  if (built !== version) {
    throw new Error(`new snapshot reports '${built}', expected '${version}'; link not changed.`);
  }

  writeFileSync(
    join(target, "DEPLOYMENT-INFO.json"),
    `${JSON.stringify(
      {
        deployedAt: new Date().toISOString(),
        deployedBy: "deploy-local",
        host: hostname(),
        commit,
        version,
        node: process.version,
        previous,
      },
      null,
      2,
    )}\n`,
  );

  try {
    repoint(target);
    cliVersion(live);
  } catch (error) {
    if (previous) repoint(previous);
    throw new Error(`could not activate ${target}; previous: ${previous ?? "none"}.`, {
      cause: error,
    });
  }

  log(`active: ${live} -> ${target}`);
  log("Reconnect running MCP clients to pick up the new version.");
}

try {
  main();
} catch (error) {
  console.error(`[deploy-local] FAILED: ${error.message}`);
  if (error.cause) console.error(error.cause.message);
  process.exitCode = 1;
}
