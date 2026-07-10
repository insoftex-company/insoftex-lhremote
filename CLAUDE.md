# lhremote — Claude Instructions

> Automation toolkit for LinkedHelper.com

## Conventions

### Naming

| Element | Convention | Example |
|---------|------------|---------|
| Files | kebab-case | `campaign-format.ts` |
| Classes | PascalCase | `CampaignService` |
| Functions | camelCase | `checkStatus()` |
| Constants | UPPER_SNAKE | `DEFAULT_LAUNCHER_PORT` |

### Commits

Format: `(type) scope: description`

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`

Example: `(feat) mcp: add campaign-create tool`

When a commit resolves a tracked issue, put `Closes #N` in the commit message body (not the subject line) — with direct pushes to `main`, GitHub closes issues from commit messages.

### Workflow

Single-developer repository — no PRs, no human or Copilot code review (Copilot review is not provisioned for this account anyway; requests silently no-op).

- Commit directly to `main` (`main` has no branch protection). Use a short-lived branch only when work needs to stay unmerged for a while.
- Run `pnpm lint` and `pnpm test` before pushing.
- CI (`ci.yml`) runs on every push to `main` — verify it stays green after pushing.

### Copyright And Attribution

- This repository is an Insoftex fork of the upstream `alexey-pelykh/lhremote` project.
- Preserve existing upstream source headers by default. Do not replace
  `// Copyright (C) 2026 Oleksii PELYKH` on inherited files just because the fork modified them.
- Repo/package metadata may attribute the fork and published artifacts to Insoftex
  (`author`, README, plugin metadata, npm package ownership).
- Add an extra `// Copyright (C) 2026 Insoftex` line only intentionally, for files that are
  newly authored by Insoftex or have been substantially rewritten under Insoftex ownership.
- Do not introduce mixed header styles ad hoc. If a broader relicensing or dual-notice policy is
  desired later, apply it repo-wide in one explicit pass rather than opportunistically file by file.

## Testing

| Tier | Scope | Environment | Dependency |
|------|-------|-------------|------------|
| 1 — Unit | Mocked CDP protocol, error handling, request correlation | CI (`vitest run`) | None |
| 2 — Integration | Real headless Chromium via `playwright-core` | CI (`vitest run`) | Chromium binary (installed by Playwright) |
| 3 — E2E | Full LinkedHelper app, real LinkedIn interactions | Local only | LinkedHelper (paid app) |

- Tier 1 and 2 run together via `pnpm test` — no separate commands needed.
- Integration tests use `*.integration.test.ts` suffix.
- Test helper `packages/core/src/cdp/testing/launch-chromium.ts` manages Chromium lifecycle.
- Chromium is installed in CI via `npx playwright-core install chromium --with-deps`.
- E2E tests live in `packages/e2e/src/` and are **not** run in CI. Always run `pnpm test:e2e` locally before pushing changes that add or modify E2E tests.
- Run a single E2E file: `pnpm --filter @insoftex/lhremote-e2e test:e2e:file <pattern>` (e.g., `list-accounts`). Do **not** use `--` before the pattern — pnpm forwards it literally and vitest ignores args after `--` for file filtering.
- E2E tests must assert preconditions explicitly — never silently skip via `if (accounts.length > 0)`. Use `resolveAccountId(port)` from `@insoftex/lhremote-core/testing` which throws if no accounts exist.
- Shared E2E helpers (`resolveAccountId`, `forceStopInstance`, `assertDefined`, `getE2EPersonId`) are exported from `@insoftex/lhremote-core/testing` — do not duplicate them locally in test files.
- `navigateToProfile` and `waitForPostLoad` can capture timeout diagnostics (URL, `document.title`, DOM probes, full-page screenshot) into a per-invocation `${os.tmpdir()}/lhremote-diagnostics-XXXXXX/` directory (created via `mkdtemp` for TOCTOU-safe atomic creation — see ADR-007 § 2026-05-05 Amendment). Trigger condition differs per helper: `navigateToProfile` captures on `CDPTimeoutError` from its underlying `waitForElement`; `waitForPostLoad` captures when its own polling deadline expires (throws a plain `Error("Timed out waiting for post detail to appear in the DOM")`). Activation in both cases is gated on `LHREMOTE_CAPTURE_DIAGNOSTICS=1`; E2E runs set it via `vitest.e2e.config.ts`, CLI/MCP are default-off. The trailing `console.warn` line emitted by the helper reports the actual artifact path. Inspect these artifacts before changing profile or post-detail selectors.

## Infrastructure

- **Monorepo**: pnpm workspace with 5 packages: `core`, `mcp`, `cli`, `lhremote`, `e2e`
- **Toolchain**: pnpm 9.15.4, Node 24, Turbo (cached via `.turbo/`)
- **CI**: GitHub Actions (`ci.yml`) — `build`, `lint`, `test` on ubuntu/macos/windows matrix
  - GH Pages docs (README + rate-limiting guide) built via pandoc on every CI run, published on push to main
  - Composite setup action: `.github/actions/setup/action.yml` (pnpm + node + playwright chromium + turbo cache)
  - Concurrency: cancel-in-progress for PRs, not for main
- **Release**: GitHub Actions (`release.yml`) — triggered by GitHub Release publish
  - Validates (build+lint+test), stamps version from tag, publishes to npm (OIDC trusted publishing)
  - Concurrency group `release`, never cancels in-progress
- **Versioning**: every file that carries a version must match the release tag. All must change together on every release — no file may lag behind:
  | File | Field(s) |
  |------|----------|
  | `package.json` | `version` |
  | `packages/core/package.json` | `version` |
  | `packages/cli/package.json` | `version` |
  | `packages/mcp/package.json` | `version` |
  | `packages/lhremote/package.json` | `version` |
  | `packages/e2e/package.json` | `version` |
  | `.claude-plugin/plugin.json` | `version` |
  | `.claude-plugin/marketplace.json` | `plugins[0].version` |
  | `server.json` | `version` and `packages[0].version` |
  - The release workflow stamps the 6 `package.json` files from the git tag but does **not** auto-bump the plugin/server files — after each release, commit an update to match the new tag.

## Remote Access (lhserver)

`lhserver` (see `~/.ssh/config`) is the Windows machine running the production LinkedHelper instances the EspoCRM sync scripts target. Two things about it are easy to get wrong:

- **Non-interactive `ssh lhserver "..."` execs run under `cmd.exe`, not PowerShell** — confirmed by `dir` returning a classic `cmd.exe` banner (`Volume in drive C has no label...`), not PowerShell's `Get-ChildItem` table format. Invoke PowerShell explicitly (`powershell -NoProfile -Command "..."`) when you need it rather than assuming PowerShell syntax works over a plain exec.
- **Auth fails silently if the local ssh-agent has dropped the key's unlocked identity, not because of a network problem.** The key is passphrase-protected; a non-interactive session (no TTY) can't be prompted, so it fails with `Permission denied (publickey,password,keyboard-interactive)` — `ssh -v` shows the server *accepting* the key, then `read_passphrase: can't open /dev/tty`. Check `ssh-add -l`; "The agent has no identities" is the actual cause. This presents the same way for any ssh-agent-held key (e.g. GitHub), not just `lhserver`. Ask the user to re-run `ssh-add` (or unlock via Keychain) — don't loop retries, and don't chase it as a routing/ARP issue (it never presents as `No route to host`, and clearing ARP caches or killing ssh processes doesn't address it).

## graphify

`.graphifyignore` excludes `dist-bundle/`, `dist-mcpb/`, `dist-mcpb-staging/` — esbuild-bundled/packaged release output, not source. Before this was added they contributed ~46% of the graph's nodes as duplicate copies of `packages/*` symbols already graphed correctly from source. If a new bundled/packaged output directory is added under a name the default skip-list doesn't catch (`dist`/`build`/`out` are skipped automatically; anything named `dist-*` or similar is not), add it here too.

## Design Decisions

Architecture Decision Records live in `docs/adr/` and explain *why* the codebase is structured the way it is:

| ADR | Decision | Code Area |
|-----|----------|-----------|
| [001](docs/adr/001-monorepo-package-structure.md) | Monorepo package structure | `packages/` (core, mcp, cli, lhremote) |
| [002](docs/adr/002-cdp-automation-via-electron.md) | CDP-based automation via Electron | `packages/core/src/cdp/` |
| [003](docs/adr/003-sqlite-direct-file-access.md) | SQLite direct file access | `packages/core/src/db/` |
| [004](docs/adr/004-three-tier-testing-strategy.md) | Three-tier testing strategy | `*.test.ts`, `*.integration.test.ts`, `packages/e2e/` |
| [005](docs/adr/005-error-hierarchy-design.md) | Error hierarchy design | `packages/core/src/*/errors.ts` |
| [006](docs/adr/006-operations-layer.md) | Operations layer | `packages/core/src/operations/` |
| [007](docs/adr/007-profile-ready-selector-strategy.md) | Profile page readiness selector strategy | `packages/core/src/operations/navigate-to-profile.ts` |
| [008](docs/adr/008-launcher-queue-readiness.md) | Launcher queue serialization and instance readiness model | `packages/core/src/cdp/launcher-queue.ts`, `instance-readiness.ts` |
| [009](docs/adr/009-async-operation-model.md) | Async operation model (grace window, OperationRegistry, AbortSignal threading) | `packages/mcp/src/operation-registry.ts`, `tools/get-operation.ts` |
| [010](docs/adr/010-campaign-target-verification-by-url.md) | Campaign target-people verification by LinkedIn URL (batch import + read-only DB confirmation) | `packages/core/src/operations/campaign-list-people.ts`, `packages/core/src/db/repositories/campaign.ts` |

## Task Tracking

- **Issues**: https://github.com/insoftex-company/insoftex-lhremote/issues
- **Milestones**: used for grouping related issues into campaigns/phases
- **Labels**: default GitHub set (bug, enhancement, documentation, etc.)
- No GitHub Projects
