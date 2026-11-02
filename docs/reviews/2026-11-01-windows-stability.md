# Windows stability review and Claude handoff

Date: 2026-11-01. Base: `ba1ecd821b564e283e9afeef1b68ccb809fc4cc6` (upstream integration already on `main`). Continue development directly on `main`, per the sole developer's instruction. Removed fully merged local `integration/upstream-2026-11-01` and remote `fix/instance-visibility-r1-r8`; the remote head was verified as `f9ac156e30cc046741a72a182a9793f52d63170e` before deletion.

## Changes for review

| Area | Failure addressed | Result |
| --- | --- | --- |
| Process inspection | Concurrent slow WMI scans; TTL expiring before completion; stale scans overwriting fresh data | Coalesce in-flight requests, age completed scans, invalidate by generation |
| Windows command lines | Default subprocess output limit on busy machines; interactive console windows; legacy WMI command | Hidden, noninteractive `Get-CimInstance`, 15 s timeout, 16 MiB output limit, UTF-8 output |
| Identity parsing | Escaped quotes and braces truncated JSON; unconditional unescaping corrupted valid raw JSON | Try raw JSON first, then decode the Windows quoting layer; retain ordinary backslashes and Unicode; validate numeric account ID |
| CDP detection | Ordinary HTTP 200 listeners mistaken for CDP | Require a JSON array with CDP target fields; allow a valid empty array |
| Restart | Timeout incorrectly counted as old-process exit; port reuse incorrectly rejected | Throw when PID remains alive; verify a different identified PID after confirmed exit, allowing port reuse |
| Forced launch | Access-denied termination treated as success, allowing duplicate application launch | Only `ESRCH` means absent; permission errors and still-live PIDs refuse replacement |
| Shutdown | Squirrel bootstrap already exited while the owned GUI stayed alive | Windows shutdown continues through the owned CDP endpoint; signal-based child exit is recognized; HTTP close/focus calls are bounded |
| Startup wrappers | Hardcoded user installation, indiscriminate termination during startup/rebinding | Shared PowerShell helper, current-user/custom binary discovery, startup mutex, quoted paths, bounded readiness checks, no automatic termination |

`docs/instance-stability.md` now describes the current PID/readiness model, session leases, cache behavior, and startup configuration. `CLAUDE.md` records direct-main development.

## Verification completed on macOS

- Node **24.21.0**, pnpm **11.8.0**. All five package builds and lint passed; generated command references match the CLI.
- Full coverage-enabled suite: **4,224 tests in 336 files passed**, no skipped Vitest tests. Core 2,884; CLI 658; MCP 664; umbrella 18. Core line coverage **90.65%**, branch coverage **83.76%**.
- Includes **203 browser integration tests in 16 files**, using installed Chromium **151.0.7922.34** through a local Playwright browser-path alias. This is not the pinned Chromium 147 download, which was unavailable locally.
- Wrote failing regression cases before fixes. Initial focused run reproduced 11 failures; the focused suite subsequently passed. Separate failing cases reproduced exited-bootstrap shutdown and access-denied forced-launch behavior before their fixes. The full suite adds 13 tests over the integration baseline.
- Legacy production deployment to a directory containing spaces and `ü` passed. The deployed dependency graph found the smoke process, CLI version/help passed, and MCP initialized and listed **87 tools**. No MCP tools were executed. Development dependencies were restored after deployment.
- Existing tests also exercise localized Windows netstat/TIME_WAIT handling, null-command-line retry, helper-process exclusion, account isolation, lifecycle cancellation, launcher locking, orphan grace/revalidation, and SQLite busy-timeout handling. Those are regression coverage, not native Windows runtime proof.
- JavaScript smoke scripts pass Node syntax checks. The native script explicitly reports **SKIPPED** on macOS.

Reproduce the complete suite with `pnpm build`, `pnpm lint`, `pnpm license-check`, and `pnpm exec turbo run test -- --coverage`. Browser integration requires Playwright Chromium. For packaging, run `pnpm --filter ./packages/lhremote deploy --legacy --prod <directory>`, then `node scripts/smoke-package.mjs <directory>`. Restore workspace development dependencies with `pnpm install --frozen-lockfile --ignore-scripts --prod=false` afterward.

## Native Windows verification prepared, not executed

The existing CI OS matrix includes Windows. Added Windows-only steps:

1. `node scripts/check-windows-runtime.mjs`: parse the bootstrap with actual Windows PowerShell 5.1; inspect a smoke-owned Node child carrying Unicode arguments through actual CIM/ps-list; find a smoke-owned TCP listener through actual netstat. Cleanup only touches the smoke's own child/socket. It does not launch or modify LinkedHelper.
2. Production deploy into a space/Unicode path, then the same deployed CLI/MCP startup smoke. These checks also exercise packaged process-inspection dependencies and pnpm vendor assets.

`workflow_dispatch` is available, but these changes have not been pushed or run in Windows CI during this review. No PowerShell runtime was installed on this Mac. PowerShell parsing and Windows execution therefore remain pending until that job runs.

## Claude review focus and remaining acceptance

Review the cache invalidation race, quoting decoder against real Electron command lines, conservative PID/permission handling, Squirrel ownership logic, and PowerShell 5.1 compatibility. Launcher serialization remains process-local; the startup helper mutex coordinates copies of the helper in one Windows session, not independent CLI/MCP servers.

Native CI is necessary but does not contain a licensed LinkedHelper desktop. On the target Windows account, verify cold launch and already-running reuse, simultaneous account starts, a launcher CDP rebind, target-only restart, cancelled lifecycle work, bootstrap-to-GUI handoff, and deliberate full-app restart. Include a slow/busy host, Unicode/space paths, access-denied processes, and extraction/startup of the distributed ZIP. Do not perform campaign actions or terminate unrelated accounts during validation.

The code is hardened and locally regression-tested; smooth operation across Windows desktop/session/antivirus conditions is **not yet demonstrated**. No live LinkedHelper accounts, campaigns, or Windows processes were modified in this review.

## Platform references

- [Node.js child process behavior, Windows shell invocation, output buffers and timeouts](https://nodejs.org/docs/latest-v24.x/api/child_process.html)
- [Node.js process signals](https://nodejs.org/docs/latest-v24.x/api/process.html)
- [Windows PowerShell 5.1 Get-CimInstance](https://learn.microsoft.com/en-us/powershell/module/cimcmdlets/get-ciminstance?view=powershell-5.1)
- [Win32_Process fields](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-process)
