# Windows lhremote verification and AI review handoff

> Historical verification snapshot: this report describes the unversioned 0.27.0 build tested before the fixes were committed and released as 0.28.0. The earlier evidence ZIP remains unchanged. The installed release's `DEPLOYMENT-INFO.json` identifies its exact Git commit.

Date: 2026-11-02, Europe/Kyiv. Final status: automated checks pass; corrected discovery and account restart verified live; tested fork deployed to `C:/Users/xuser/scripts/lhremote`.

## Revision and scope

- Base: `c661732bdfa120abeecfb37ef01c9231f3b13a2d`, Windows process/lifecycle hardening.
- Integration: `ba1ecd821b564e283e9afeef1b68ccb809fc4cc6`, importing upstream through `e162cd2` and preserving Insoftex features.
- Reviewed recent first-parent changes against `21c643f8eb882e224784bbbc5494bb2a0d05df76`.
- Final changes remain uncommitted on the existing branch. Review the supplied source overlay and `working-tree.patch` against the base, rather than treating the base commit alone as the tested revision.
- No campaign/message/contact/profile mutation tests were run against production. The user subsequently authorized live restarts and confirmed they would leave LinkedHelper untouched during verification.

## Confirmed causes and fixes

### 1. Windows omitted live TCP listeners

For a smoke-owned listening socket, `netstat -ano` returned no matching row. `Get-NetTCPConnection` found the socket, with raw CIM state **0**, surfaced as null by its formatted `State` property. Consequently, `Get-NetTCPConnection -State Listen` also returned no row.

The final fix retains netstat as the PID-to-port fast path, then queries the Windows TCP provider when netstat fails or returns no listeners. It identifies listeners by remote port zero and wildcard remote address, validates numeric results, deduplicates them, and leaves CDP verification to the existing `/json/list` probe. Reverse port-to-PID lookup uses the same provider on Windows and returns no PID for absent or ambiguous owners. Other platforms retain `pid-port` behavior.

Concrete live comparison before restarting the app:

| Same process | Old global build | Corrected build |
|---|---|---|
| Launcher PID 3016 | CDP 9222, connectable | CDP 9222, connectable |
| Account runner PID 14684 | No CDP port, not connectable | CDP 56670, connectable |

The account runner had no `--remote-debugging-port` argument. Its existing dynamic endpoint was nevertheless usable. Therefore, absence of that argument was not evidence that account CDP was disabled. The shipped fix does not inject a debugger hook or patch LinkedHelper binaries.

The integration tests now verify lhremote's own reverse lookup against the exact smoke Chromium PID. Testing the third-party `portToPid` implementation directly reproduced the same unreliable Windows enumeration behavior. Native enumeration test budgets reflect the bounded subprocess calls rather than Vitest's default five seconds.

### 2. Direct account startup omitted modern version selection

During the authorized restoration, the previous direct `mainWindow.startInstance` path failed with:

```text
Failed to initialize: database version 228 is newer than supported version 227
```

Starting the same account through the launcher UI selected installed runner **2.130.77** and succeeded. Inspection of the installed frontend's `startLinkedInAccountLocal` implementation showed that it determines the workspace-compatible instance version, ensures it is downloaded, and supplies version/workspace/cloud arguments absent from lhremote's reconstructed legacy call.

`LauncherService.startInstance` now prefers that native workflow, preserves already-running recovery behavior, passes `shouldStartRunningCampaigns: false`, and propagates native failures without falling through to legacy startup. The legacy implementation remains available only when the native method is absent. Four executable-expression regression tests cover native delegation, flags/receiver binding, failure handling, already-running state, and legacy fallback.

### 3. Client and deployment versions differed

The original global command pointed into this repository's stale compiled output. An active MCP process separately ran cached unscoped upstream package **lhremote 0.20.1**, not the Insoftex fork. Its live discovery also mislabeled Chromium helper children as account instances.

The production fork is now deployed at `C:/Users/xuser/scripts/lhremote`, and the existing pnpm global registration points there. The local `~/.codex/config.toml` lhremote entry now uses the absolute Node executable and deployed CLI instead of `npx lhremote mcp`; other settings and tool policies were preserved. This command/args configuration follows the [official local MCP configuration documentation](https://learn.chatgpt.com/docs/extend/mcp#configure-with-configtoml).

The safe repository startup CMD/PowerShell scripts and a relative-path VBS wrapper were copied to `~/scripts`. The former deployed silent script's image-wide termination was removed by replacing it with the existing safe repository implementation. Other CRM scripts and their dependencies were left in place.

## Final automated results

Windows; Node **24.22.2** for the final suite, Node **26.3.1** for deployed CLI/MCP smoke; pnpm **11.8.0**; Vitest **4.1.5**; Playwright **1.59.1**; pinned Chromium **147.0.7727.15**, revision **1217**.

| Package | Passed | Failed | Skipped | Files | Line coverage | Branch coverage |
|---|---:|---:|---:|---:|---:|---:|
| core | 2,903 | 0 | 0 | 164 | 90.68% | 83.90% |
| cli | 658 | 0 | 0 | 76 | 89.84% | 81.30% |
| mcp | 664 | 0 | 0 | 93 | 92.34% | 82.14% |
| lhremote | 18 | 0 | 0 | 4 | 100% | 100% |
| **Total** | **4,243** | **0** | **0** | **337** | All configured gates passed | All configured gates passed |

Core line coverage is **90.68%** and branch coverage is **83.90%** in the final run. Integration coverage comprises 203 core tests in 16 files and another 13 CLI/MCP integration tests in two files. These include real Chromium/CDP, loopback servers, and temporary SQLite fixtures.

Additional checks:

- All five TypeScript package builds passed, including E2E source typechecking.
- ESLint across all packages passed; generated command README validation passed.
- License check passed for 113 production dependencies.
- Python tooling tests passed: 14 tests, 66 checks. Memory-freshness lint was warning-only and reported two overdue repository notes and one warning; those notes were not edited.
- Native Windows PowerShell parsing, Unicode process-command-line inspection, and smoke-owned listener discovery passed. The bootstrap was parsed, not executed, by that native smoke.
- Production-package CLI version/help and MCP initialization/list-tools passed. Both the absolute Node invocation and the global `lhremote.cmd mcp` transport exposed **87** fork tools with object input schemas.
- The official Playwright download completed, but its Node extractor stalled. The exact downloaded revision 1217 archive was extracted with Python into the task's temporary browser directory; no substitute browser version was used.

The initial suite could not run browser tests before installation finished. An initial Node 26 run also had two transient search-results page-target failures. All final results above use Node 24 with the pinned browser, with no skipped tests. Preliminary failures are not counted as final passing evidence.

## Final live verification

After the application restart and normal-UI restoration, the user renewed permission for verification while leaving the application untouched. The final deployed command was:

```powershell
lhremote restart-instance 355899 --force --cdp-port 9222 --json
```

It completed successfully:

```json
{
  "accountId": 355899,
  "restarted": true,
  "oldPid": 16736,
  "newPid": 15524,
  "cdpPort": 56900,
  "verified": true,
  "launcherRecovered": false
}
```

The new executable was `.../linked-helper/Instances/2.130.77/linked-helper.exe`. Final global discovery showed launcher PID **18668** on **9222** and runner PID **15524** on **56900**, both connectable. A separate read-only `InstanceService.connect()` reached both targets, found `window.mainWindowService`, and read LinkedIn host `www.linkedin.com` with document readiness `complete`. The earlier database-version error was absent. No outbound LinkedIn actions were executed.

Only the previously running account was restored/restarted. No additional stopped accounts were started for testing. The earlier application shutdown used the verified launcher endpoint and targeted cleanup of its recorded account process; no process-image-wide kill was issued by this validation.

## Data and configuration boundary

- Automated SQL writes used synthetic temporary fixtures only. No production campaign/profile/contact/message SQL mutation was issued.
- No manual LinkedHelper database downgrade, restore, schema edit, or saved-settings edit was performed.
- Live restarts and native startup were explicitly authorized and can cause LinkedHelper's own normal persistence and backup activity. The LinkedHelper config hash changed during this live session; byte-for-byte preservation after restarting the application is not claimed.
- MCP client configuration and global command registration were intentionally updated for the deployed fork. Private config backups are outside the evidence ZIP; the ZIP contains only sanitized command/path metadata and hashes.
- No full production E2E suite was run. Only the scoped lifecycle verification and read-only target checks above were performed.

## Deployment and client follow-up

- Runtime: `C:/Users/xuser/scripts/lhremote/`.
- Entry wrappers: `~/scripts/lhremote.cmd` and `~/scripts/lhremote.ps1`.
- Startup files: `launch-linkedhelper.cmd`, `launch-linkedhelper-silent.cmd`, `launch-linkedhelper.ps1`, and `launch-linkedhelper-silent.vbs`.
- MCP JSON definition: `~/scripts/lhremote-mcp-config.json`, suitable for clients accepting a local `mcpServers` definition. No existing Claude Desktop config was located, so this definition was prepared rather than claiming a verified GUI configuration change.
- Backup: `C:/Users/xuser/scripts/backups/lhremote-20261102-155600/`. It includes previous startup scripts, global shim files, and previous global-link metadata. `unused-staging-package` is an unused intermediate artifact, not the previous production rollback target.
- Package version remains **0.27.0**. `DEPLOYMENT-INFO.json` and the full evidence manifest identify this uncommitted patch. All **352 deployed runtime JavaScript files** matched the tested build. Workspace package files were detached from build hardlinks to keep later builds from silently changing the deployment.
- Existing MCP client processes still holding old modules need to reconnect/restart. Both standard transports were verified independently; Claude/ChatGPT GUI reconnection was not automated. Windows Computer Use's native pipe was unavailable, so the live launcher inspection used the already available CDP connection.
- LinkedHelper was left running with the restored account connectable. The user was told verification was complete and they could use the application again.

## Reproduction and evidence

Use a fresh disposable checkout of the base plus the source overlay, not the production-linked working directory. Install the pinned pnpm and dependencies, install the matching Playwright Chromium, then build all packages. Each final package test ran its actual Vitest runner from its own package directory:

```powershell
node ../../node_modules/vitest/vitest.mjs run --coverage --coverage.reportOnFailure --reporter=default --reporter=json --outputFile=final-results.json
```

Run that in `packages/core`, `packages/cli`, `packages/mcp`, and `packages/lhremote`, using Node 24 and the correct `PLAYWRIGHT_BROWSERS_PATH`. Direct package runners avoided the archive-only copy's Turbo/gitignore traversal problem and pnpm's dependency-layout reconciliation. The assertions, root Vitest setup, and coverage gates were unchanged.

The ZIP under `tmp/lhremote-validation-2026-11-02.zip` contains this report, final raw logs, JSON test reports, LCOV files, sanitized runtime evidence, deployment hashes, the tracked diff, and changed-source overlay. `SHA256SUMS.txt` fingerprints the individual evidence files. Task working material remains in `%TEMP%/lhremote-validation-20261102-070157/`; exploratory tests from abandoned approaches are not part of the final patch or final test counts.

## Requested independent AI review

1. Check the Windows listener predicate for established/client-socket false positives, numeric validation, timeouts, and ambiguous reverse ownership.
2. Verify that reverse lookup preserves account/process isolation, particularly its use by legacy discovery and cleanup.
3. Review native frontend startup delegation, no-campaign flags, already-running state, failure propagation, legacy fallback, and behavior during slow downloads or cancellation.
4. Confirm tests execute the relevant branches rather than merely matching script text; inspect the raw live restart and target-connect evidence.
5. Check deployed command resolution, absence of temporary-path symlink dependencies, and stale upstream MCP cache handling. Do not infer the patch identity from version 0.27.0 alone.
6. Keep campaign actions, database migrations/downgrades, software updates, and broader production E2E outside a read-only review unless separately authorized.
