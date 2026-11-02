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
- Test helper `packages/core/src/cdp/testing/install-document.ts` installs fixture markup into that page. Every Tier-2 install goes through it and none calls `Page.setDocumentContent` directly: it does not return until the installed document has been observed through the same `client.evaluate` path the assertions use, and without that gate an evaluation landing on a document that is not the one just installed counts 0 for every selector rather than throwing — a clean, wrong number (#888).
- Chromium is installed in CI via `npx playwright-core install chromium --with-deps`.
- Tier 1's "no external dependencies" column is **enforced**, not just documented, on two axes: the root `vitest.setup.ts`, wired in through `vitest.config.ts`'s `setupFiles`, both **replaces `fetch` and `WebSocket`** and **pins `LHREMOTE_CAPTURE_DIAGNOSTICS` off**, for every `*.test.ts` that is not `*.integration.test.ts` or `*.e2e.test.ts`. **Network**: a unit test that reaches the live network fails, and the message names the call and its site. Blocked calls are recorded as well as thrown, because the call sites that matter swallow errors (`isCdpPort()` does `catch { return false; }`), so `afterEach`/`afterAll` drain hooks fail the test even when the throw never reaches it. **Diagnostic capture**: the capture sites read that variable per call rather than at module load, so a unit suite that drives an operation into a capture without mocking `node:fs/promises` wrote a real `lhremote-diagnostics-*` bundle — LinkedIn page content — whenever the launching shell happened to export it, out of a green run (#925). The setup file captures the ambient value once, deletes it before the test file's own module is evaluated (so a file reading it at module scope sees the pinned state), re-deletes it in `beforeEach` so a test that dirties it cannot leak into the next, and restores the ambient value — including the unset case — in `afterAll`, because the worker is reused across files. A deliberate opt-in inside an `it()` body still wins: under vitest's default `sequence.hooks: "stack"` the setup file's `beforeEach` runs first. The escape hatch for both is the `*.integration.test.ts` suffix, and it is one-directional — Tier-2 work misnamed `*.test.ts` fails loudly, Tier-1 work misnamed `*.integration.test.ts` runs unguarded and silently. **The pin is Tier-1 only, deliberately**: Tiers 2 and 3 keep whatever the shell exported, since Tier 2's dependency column is the Chromium binary rather than `None` and a Tier-2 run under an operator's own export is that operator's opt-in; `vitest.e2e.config.ts` declares no `setupFiles` at all, so its `env: { LHREMOTE_CAPTURE_DIAGNOSTICS: "1" }` is untouched. Limits: the network guard covers `fetch` and `WebSocket` only, and the pin covers that one variable only — `node:http`, raw sockets, other filesystem routes and the `ps-list`/`pid-port` process probes stay convention-enforced. Each package carries a canary (`packages/{cli,mcp,lhremote}/src/tier1-network-guard.test.ts`, plus `packages/core/src/testing/tier1-network-guard.test.ts` which is also the full behavioural suite) because a package-level `vite.config.*` or `vitest.config.*` would stop the root config resolving and silently detach both guards for that package alone; each asserts the guard's `globalThis` handle, not merely that the variable is unset, because nobody exports it in CI and that assertion would pass there with the config detached. The network guard is additionally **displaceable from inside a file**: a `vi.stubGlobal` over `fetch` or `WebSocket` replaces it for the remainder of that file, and neither reset nor restore puts it back — only `vi.unstubAllGlobals()` does (#935). That suite grades the mechanism — that a stub displaces the guard, and that releasing it restores the guard rather than the platform's own `fetch` — but only across its own hooks; whether every OTHER suite releases stays convention-enforced, per `.github/instructions/tests.instructions.md`. `unstubGlobals: true` would close the class config-wide instead, and is refused: vitest runs it from `onBeforeTryTask`, before every test attempt, so it would tear down the deliberate module-scope `WebSocket` stub in `packages/core/src/cdp/client.test.ts` before that file's first test. See ADR-004 § 2026-09-06 Amendment and § 2026-09-07 Amendment.
- The action-budget suite is additionally guarded against **timezone** drift, because its day boundary is the one place a test compares a JS-derived date against a SQL-derived one: `action-budget.ts` filters on `date('now', 'localtime')`, so the fixture must build the same *local* calendar day — `toISOString()` gives the UTC day, and the two disagree for one offset-width of every day, on a machine ahead of UTC and on one behind it alike, which a UTC runner cannot see and which failed nightly on any machine at a non-zero offset (#942). The `ci` job therefore re-runs that one file under `Pacific/Kiritimati` (UTC+14) and `Pacific/Midway` (UTC-11), whose divergence windows between them cover every hour of the day; the step first asserts that each zone resolves to the offset that argument assumes, so a missing or re-pointed tzdata entry fails it loudly instead of reducing it to a second UTC run. `.github/workflows/ci.yml` carries the reasoning, including why one platform suffices and why it invokes the package script rather than `pnpm test`.
- E2E tests live in `packages/e2e/src/` and are **not** run in CI. Always run `pnpm test:e2e` locally before pushing changes that add or modify E2E tests.
- Run a single E2E file: `pnpm --filter @insoftex/lhremote-e2e test:e2e:file <pattern>` (e.g., `list-accounts`). Do **not** use `--` before the pattern — pnpm forwards it literally and vitest ignores args after `--` for file filtering.
- E2E tests must assert preconditions explicitly — never silently skip via `if (accounts.length > 0)`. Use `resolveAccountId(port)` from `@insoftex/lhremote-core/testing` which throws if no accounts exist.
- Shared E2E helpers (`resolveAccountId`, `forceStopInstance`, `assertDefined`, `getE2EPersonId`) are exported from `@insoftex/lhremote-core/testing` — do not duplicate them locally in test files.
- Failure diagnostics (URL, `document.title`, DOM probes, full-page screenshot) are captured into a per-invocation `${os.tmpdir()}/lhremote-diagnostics-XXXXXX/` directory (created via `mkdtemp` for TOCTOU-safe atomic creation — see ADR-007 § 2026-05-05 Amendment). **Capture is not timeout-only**: it fires on readiness timeouts AND on extraction failures, which never reach a deadline. Trigger condition per site: `navigateToProfile` and `navigateToCompany` each capture on `CDPTimeoutError` from their underlying `waitForElement`, under their own artifact stems; `waitForPostLoad` captures when its own polling deadline expires, then throws a typed error classified from a post-deadline variant probe — `DOMVariantUnsupportedError` when no post-detail adapter claims the page, `DOMVariantAmbiguousError` when more than one does, `ExtractionTimeoutError` otherwise; `getPost` captures on the `DOMVariantUnsupportedError` / `DOMVariantAmbiguousError` its post-detail scrape raises, on the `ExtractionFailedError` raised when a scrape contradicts a cardinal the same page rendered (`commentCount` / `totalReactions` > 0 next to an empty list), and, since #951, on the `ExtractionFailedError` its CONTAINER-tier corroboration raises over the engagement-counts row; `getPostStats` captures on those same two variant errors, raised by the same generated script on the same page — it shares `getPost`'s capture helper rather than keeping a second copy of it — and, since #852, on that same container-tier `ExtractionFailedError`, raised when the selected adapter's own engagement-counts row resolved beside three zero counters, which is a contradiction within one well-formed record rather than a selection outcome. Both operations reach that branch through one shared `assertPostDetailCountsCorroboration` (#951): they sum the same three counters of the same record and write the same capture on the way out, so the binding lives beside the capture helper for the reason the helper is there. Where they differ is the tier COUNT, not the tier: `getPostStats` has no CARDINAL branch, because its counters ARE its extraction and no list sits beside them to contradict, while `getPost` carries both and runs the container tier FIRST — its `commentCount` is read out of the very row that tier grades, so a cardinal is worth consulting only once its region has been vouched for, and an unread row would otherwise supply a zero that corroborates any empty comment list. On today's counter domain the two cannot both fire, so that order is a written-down precedence rather than an observable one. `getPost`'s container branch is also unconditional, unlike its cardinal branch: `commentCount: 0` on the input skips comment loading, not counter reading. The arm where the counts row did NOT resolve returns normally and writes nothing — an ordinary post with no engagement, and capturing there would write page content on every one of them. On `sdui` that is the only reachable arm (`counts: []`, unmeasured — #950); `waitForReactionsModal` captures when its own polling deadline expires and classifies the same three ways against the reactions-modal adapters (`ExtractionTimeoutError` naming the reactions modal as its subject); `getPostEngagers` captures on both classes, at every branch that refuses — the `DOMVariantUnsupportedError` / `DOMVariantAmbiguousError` its modal scrape raises when no adapter resolves the modal root, the `ExtractionFailedError` above, and, since #911, the `DOMVariantAmbiguousError` its earlier reactions-**trigger** find raises on a hybrid page — the last of those before any click, so that bundle's modal-scoped probes read as an absent modal because none was attempted, not because one failed to open; its `variantDetection` is what carries the diagnosis there, adding the per-anchor match counts the ambiguity report itself cannot; `waitForSearchResults` captures when its own polling deadline expires, ahead of the classification rather than per-branch, so all three of its outcomes get an artifact; `searchPosts` captures on both classes, like the two operations above it — the `DOMVariantUnsupportedError` / `DOMVariantAmbiguousError` its scroll-loop scrape raises when no adapter reads the page or two claim it, and the `ExtractionFailedError` raised when `postCardCount` > 0 contradicts an empty `posts`. The post-detail, reactions-modal and search-results artifacts name their own trigger, in the filename stem and in a `trigger` field inside the bundle (the `navigateTo*` artifacts are timeout-only and carry neither). The post-detail, reactions-modal and search-results bundles also carry `variantDetection` — `matched` plus per-registered-adapter detect counts, read together: nothing matched means LinkedIn served a dialect we don't know (register an adapter), two or more means a hybrid page (tighten the detect anchors), exactly one means our adapter matched and that field's selectors went stale. `null` there means the probe yielded no usable reading, which is **not** the claim that no adapter matched. **On search-results that reading has one more branch**: nothing matched means an unknown dialect OR a search that legitimately matched nothing, which no probe in the bundle can separate — the body-text snippet and the screenshot are what settle it, and no "empty results" selector is probed because none has been measured on either dialect. That bundle additionally carries a cumulative card funnel (`candidateCardCount` → `cardsClearingHeightFloor` → `cardsWithAuthorLink` → `cardsWithMenuButton`, generated from the adapter registry so it mirrors the card loop's own filters), where the number collapses being the layer that broke, plus a `cardinals` block pairing `postCardCount` with the extraction it contradicts — `null` there means no scrape settled, which under `readiness-timeout` means none was attempted and under `extraction-failure` means the scrape itself was unreadable. **The post-detail bundle carries a registry-derived field of its own, `variantAnchors`**: one reading per registered post-detail adapter, keyed by that adapter's `variant`, each giving the match count for its `ready` anchor and a per-selector map for its `scopes` and `counts` candidates — generated by `buildPostDetailAnchorProbeSource` and spliced into the capture's single existing page read, so a dialect renamed in the registry cannot keep being reported under its old name. Read it *with* `variantDetection`, which answers a different question: `variantDetection` says which dialect the page is, `variantAnchors` says how far that dialect's own anchors got, and the fixed-selector probes beside them say how far the page got in markers no dialect owns — an exactly-one `variantDetection` next to an all-zero `variantAnchors` entry for that same dialect is a claimed-but-unhydrated page, which neither field states alone. `detect` is deliberately absent from `variantAnchors`: it is read on the classification path and reaches the bundle as `variantDetection`, so giving it a second home would report one anchor **role** twice. That is about the role, not the selector — a dialect may use one string in two roles, and `legacy`'s `detect` **is** its `scopes[0]`, so that selector is read once per probe and the two counts can differ because the reads are seconds apart on a hydrating page; read a disagreement as evidence about the page, and check a `ready` or `counts` anchor before concluding a dialect claimed the page without hydrating. It replaced the hand-maintained `hasPostDetailContainer` boolean and is **wider** than it — the same selector is still read, as a count under `sdui`, alongside the SDUI screen wrapper, both dialects' `ready` anchors and the legacy `.social-details-social-counts` row, none of which was probed before. The selector constants `wait-for-post-load.ts` still hand-maintains are markers **no adapter anchors on** and must stay: a failed read wants a which-of-these-is-missing picture wider than any single adapter's binding. See ADR-007 § 2026-09-01 Amendment, its two § 2026-09-04 extensions (#870, the search-results sites; #853, the post-detail `variantAnchors`), its § 2026-09-05 Amendment (#890, `getPostStats` — the last **post-detail** failure site that captured nothing), its § 2026-09-06 Amendment (#911, the `getPostEngagers` reactions-trigger **branch** — an existing site's last branch that refused without writing one, not a new site), and its § 2026-09-08 Amendment (#852, the `getPostStats` counts-row corroboration **branch** — again an existing site, and the first whose refusal arrives from a well-formed record; #951 carried that same branch to `getPost`, which adds no site and no trigger — the two now share one helper), and ADR-011 § 2026-09-02 Amendment (#840) for the reactions-modal binding that made its `variantDetection` field readable at all. Activation at every site is gated on `LHREMOTE_CAPTURE_DIAGNOSTICS=1`; E2E runs set it via `vitest.e2e.config.ts`, CLI/MCP are default-off — the artifacts contain page content, i.e. personal data. The trailing `console.warn` line emitted by the helper reports the actual artifact path. Inspect these artifacts before changing profile, post-detail, reactions-modal or search-results selectors.

## Infrastructure

- **Monorepo**: pnpm workspace with 5 packages: `core`, `mcp`, `cli`, `lhremote`, `e2e`
- **Toolchain**: pnpm 11.8.0, Node 24, Turbo (cached via `.turbo/`)
- **CI**: GitHub Actions (`ci.yml`) — `build`, `lint`, `test` on ubuntu/macos/windows matrix
  - GH Pages docs (README + rate-limiting guide) built via pandoc on every CI run, published on push to main
  - Composite setup action: `.github/actions/setup/action.yml` (pnpm + node + playwright chromium + turbo cache)
  - Concurrency: cancel-in-progress for PRs, not for main
  - `memory-freshness` job (ubuntu only, stdlib Python, no pnpm setup): runs `tools/check-memory-freshness.py`, which grades the `volatility` / `last-verified` frontmatter on every entry in `.claude/memory/`. Currently `--warn-only`, so drift reports without failing; ungradeable frontmatter and a zero-entry scan still fail. Flip to blocking once the corpus is clean (#912)
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
| [011](docs/adr/011-readiness-binding-and-empty-vs-error-contract.md) | Readiness binding and the empty-vs-error contract (post-detail; search-results and reactions-modal per the § 2026-09-02 Amendments) | `packages/core/src/linkedin/dom-variant.ts`, `packages/core/src/linkedin/corroboration.ts`, `packages/core/src/cdp/wait-for-post-load.ts`, `packages/core/src/cdp/wait-for-reactions-modal.ts`, `packages/core/src/operations/get-post.ts`, `packages/core/src/operations/get-post-engagers.ts`, `packages/core/src/operations/get-post-stats.ts`, `packages/core/src/operations/search-posts.ts`, `packages/core/src/services/errors.ts` |

## Task Tracking

- **Issues**: https://github.com/insoftex-company/insoftex-lhremote/issues
- **Milestones**: used for grouping related issues into campaigns/phases
- **Labels**: default GitHub set (bug, enhancement, documentation, etc.)
- No GitHub Projects
