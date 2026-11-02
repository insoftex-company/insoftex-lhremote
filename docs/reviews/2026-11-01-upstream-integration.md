# Upstream integration and six review fixes — Claude handoff

## Review scope

Work is on local branch `integration/upstream-2026-11-01`. The starting fork revision was `21c643f`. Upstream `alexey-pelykh/lhremote` was imported through `e162cd2f81622641a3aacb8d677e800f2c3e86b0` (September 10, 2026), with common ancestor `fad665ded659286cd5fc15763e5625f79e0be862` / v0.20.1. This imports the 264 upstream commits absent from the fork while preserving its 61 unique commits.

This is a local integration for review. `main` has not moved; nothing was pushed, published, deployed, or run against production LinkedHelper/LinkedIn accounts. Package versions remain `0.27.0`; these are unreleased source changes. Existing tracked release bundles and the knowledge graph were not regenerated.

Review the complete result against the original fork, rather than only against the second parent of the merge:

```sh
git diff --stat 21c643f HEAD
git diff 21c643f HEAD -- packages scripts .github turbo.json vitest.config.ts
git log --first-parent --oneline 21c643f..HEAD
git merge-base --is-ancestor e162cd2f81622641a3aacb8d677e800f2c3e86b0 HEAD
```

## What was imported

- LinkedIn DOM variant adapters, scoped post/search/feed parsing, feed-author extraction fixes, typed extraction failures, diagnostic capture, sanitized fixtures, and browser oracles. Incorrect or corroborated-empty extraction now raises errors instead of returning silently misleading successes.
- CLI/MCP asynchronous startup and import-error handling, deferred loading of the MCP graph, and matching CLI entrypoint behavior.
- Error cause formatting, reaction action-budget enforcement, unit-test network guards, package-relative coverage configuration, timezone regressions, fixture installation helpers, and LF checkout normalization.
- Upstream fixture-harvesting and memory-freshness tooling. The freshness checker reports two overdue upstream entries and one warning; their verification dates were not fabricated or advanced.

The 20 conflicting paths were reconciled. New upstream `@lhremote/*` imports and CI commands were mapped to this fork's `@insoftex/*` names. The incoming DOM ADR was renumbered **011**, preserving the fork's existing ADRs 008–010 and updating DOM references. Generated CLI/MCP command tables remain managed by the fork's existing script.

Preserved fork behavior includes Windows WMI/UTF-8 identity extraction, shared null-command-line retries, listener-only/per-row netstat parsing, process caching and invalidation, account-scoped lifecycle verification, explicit CDPClient ownership without autonomous reconnect, launcher recovery/queue/readiness, async lifecycle tools, organization campaigns, URL verification, and external-ID fan-out fixes.

## Six fixes

| Finding | Implementation | Main review targets |
| --- | --- | --- |
| R1 — wrong account/session | Extended the shared CDP resolver with an optional fourth `accountId` argument. Direct DOM operations and recovery wrappers forward it; account-backed database scopes use the same resolver. Explicit account/port mismatches and unknown identities are rejected. Launcher ports select an instance by account. Automatic selection without an account fails when several instances are connectable. CLI DOM commands expose `--account-id`. | `core/src/cdp/app-discovery.ts`, `services/instance-context.ts`, `operations/with-logged-in-state-retry.ts`, DOM operations, CLI/MCP handlers |
| R2 — cancellation continues starts | Batch starts, shared start/recovery helpers, readiness/PID waits, restart, and queue settling receive/check AbortSignal. Aborted work cannot become a successful late return. The registry retains physical writer ownership until cancelled work and cleanup actually settle, rejecting replacement lifecycle requests meanwhile. Already-aborted MCP requests never enter the work callback. | `core/src/services/ensure-instances.ts`, `instance-lifecycle.ts`, `restart-instance.ts`, `cdp/launcher-queue.ts`, `mcp/src/operation-registry.ts` |
| R3 — incomplete launcher locking | LauncherService automatically leases the CDP gate for connect/reconnect through disconnect/failure. Existing grouped gate callbacks use an async-local scope with serialized inner service leases. Batch starts release the supplied session before queue acquisition, enforcing queue → gate → connection order. Database operation health checks use short launcher sessions; launcher connection failure remains best-effort, with instance popups still checked. | `core/src/cdp/launcher-cdp-gate.ts`, `services/launcher.ts`, `ensure-instances.ts`, `instance-context.ts` |
| R4 — stuck instances hidden from orphan detection | Only connectable input PIDs are excluded as live. Candidates are inspected afresh and must remain non-connectable through the readiness grace window. Reaping rechecks PID/account identity, port, connectivity and stuck eligibility immediately before termination; changed or unidentified candidates are skipped. Dry run remains the default. | `core/src/cdp/process-inspector.ts` and its composition/grace/revalidation tests |
| R5 — pnpm Windows packaging failure | Windows packaging explicitly uses `pnpm deploy --legacy --prod`, compatible with the current non-injected workspace and pinned pnpm 11.8.0, then restores development install state to avoid subsequent non-interactive purge prompts. | `scripts/package-for-windows.sh` |
| R6 — incorrect post counters | Adopted upstream's shared adapter-based, scoped per-element extraction and corroboration instead of whole-body textContent regexes. Includes the imported browser fixtures/oracles. | `core/src/operations/get-post-stats.ts`, `get-post.ts`, `linkedin/dom-variant.ts` |

Additional integration correction: CI now calls `pnpm exec turbo run test -- --coverage` on Ubuntu. The previous nested pnpm/turbo separators reached Vitest as `-- --coverage`, so coverage never enabled under pnpm 11. The test task also forwards `PLAYWRIGHT_BROWSERS_PATH` for custom local browser installations.

## Behavior changes to assess

- Account-bound CDP selection deliberately fails closed if local process inspection cannot establish identity. Remote account-bound DOM operations must run lhremote on the target host; a remote host's identity is not inferred from local processes. Existing explicit remote CDP calls without an account selector retain the underlying remote opt-in behavior.
- `waitForConnectable` and PID/start waits throw on cancellation instead of reporting cancellation as a normal timeout/false result. Existing positional arguments remain compatible; new signal/options arguments are optional.
- `ensureInstances` disconnects its supplied launcher before entering the lifecycle queue, then reconnects/disconnects around individual starts. Callers must not assume that launcher remains connected after the batch.
- A newly observed non-connectable orphan candidate can add the configured grace window (default 30 seconds) to an orphan scan. This lets a fresh CLI process establish history instead of immediately killing a starting instance.
- An operation may show `cancelled` while cleanup is still pending. It remains the active writer until that cleanup ends. Cancellation cannot undo an RPC already accepted by LinkedHelper.
- The upstream extraction error behavior is a runtime compatibility change for consumers that interpreted empty arrays/zeroes as success on unsupported markup.

## Verification

Final source was built and tested on macOS arm64 with **Node 24.21.0** and **pnpm 11.8.0**.

| Check | Result |
| --- | --- |
| TypeScript build | All five packages passed through Turbo prerequisites |
| Lint and generated command-reference consistency | Passed |
| Full suite with V8 coverage | **4,211 tests passed, 336 files passed, no skipped tests** |
| Browser integration portion | **203 tests passed** across 16 files; included in the total above |
| Coverage thresholds | Passed in all four tested packages |
| Production dependency license check | 113 dependencies passed |
| Action-budget timezone regressions | Five tests passed in each of Pacific/Kiritimati and Pacific/Midway |
| Python freshness-checker tests | 14 tests / 66 checks passed |
| Freshness corpus check | Passed in warn-only mode; two overdue entries and one warning remain |
| Production package staging | Legacy production deploy passed, including a final offline staging run |
| Staged CLI/MCP smoke | Version/help and MCP initialization/list-tools passed; 87 tools registered; no tools executed |

Coverage percentages (statements / branches / functions / lines):

| Package | Coverage |
| --- | --- |
| core | 89.77 / 83.61 / 91.34 / 90.66 |
| cli | 89.71 / 81.30 / 89.07 / 89.84 |
| mcp | 92.12 / 82.14 / 95.65 / 92.34 |
| lhremote | 100 / 100 / 100 / 100 |

Reproduction commands:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm lint
pnpm exec turbo run test -- --coverage
pnpm license-check
TZ=Pacific/Kiritimati pnpm --filter @insoftex/lhremote-core test src/db/repositories/action-budget.test.ts
TZ=Pacific/Midway pnpm --filter @insoftex/lhremote-core test src/db/repositories/action-budget.test.ts
python3 tools/check-memory-freshness.test.py
python3 tools/check-memory-freshness.py --warn-only
```

Browser evidence used an already installed Chromium **151.0.7922.34**, selected through a temporary Playwright browser-path alias. The exact Chromium 147 build selected by Playwright 1.59.1 was not available locally; its installer stalled. CI still installs the pinned browser normally. This is real CDP/browser evidence, but not validation against that exact browser build.

Detailed local logs and staged packages are under `/tmp/lhremote-review.Wo1Vjz/`: `final-tests-coverage.log`, `final-lint.log`, `final-packaging.log`, `final-package-smoke.log`, `python-tests.log`, and `memory-freshness.log`. These temporary artifacts are not committed.

## Claude review request

Please review this integration against `21c643f`, concentrating on:

1. Account-to-port binding across CLI, MCP, database-backed operations, and retry recovery. Confirm the explicit/automatic/multi-account/unknown-identity paths cannot pair the wrong session with a database.
2. Launcher lease cleanup on connect/bind/recovery failures and disconnected-client reuse; nested gate scopes; queue/gate ordering in ensure/start/restart; and preservation of instance-only operation during launcher outages.
3. Cancellation after an accepted start RPC, between accounts, during recovery/settle/waits, and while cleanup still owns the writer. Check that no later account starts and no replacement writer slips through.
4. Orphan grace/revalidation, conservative handling of unknown identities, and the unchanged dry-run default. All process-kill regression tests use mocks.
5. Whether upstream's new extraction failures and reaction-budget requirements need caller adjustments in Insoftex integrations.
6. pnpm 11 packaging and CI coverage forwarding, package namespace remapping, and preservation of Windows-specific discovery/lifecycle code.

Please report severity, precise file/line, a concrete failure scenario, and the missing regression test for each finding. Do not deploy or run real LinkedIn actions as part of this review.

## Remaining validation before promotion

- Run the Windows and Linux CI matrix; it has not been triggered because this branch has not been pushed.
- On an isolated Windows LinkedHelper setup, validate WMI identity and listener discovery, two-account routing, start/cancel/restart behavior and launcher contention. Verify grace-period orphan behavior with controlled processes.
- Produce and unpack the ZIP on Windows and run its CLI/MCP entrypoints. Local staging validation did not execute the Windows shell/ZIP workflow on Windows.
- Run licensed LinkedHelper E2E tests with controlled targets before any production promotion. Imported E2E source changes were typechecked/linted but no real LinkedHelper E2E suite was executed.
- Regenerate release bundles and bump all release metadata only when preparing an approved release. The source integration alone is not a deployed release.
