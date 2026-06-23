# @insoftex/lhremote-cli

CLI for [lhremote](https://github.com/insoftex-company/insoftex-lhremote) — LinkedHelper automation toolkit.

This package provides a command-line interface that mirrors the full MCP tool surface. Every MCP tool has a corresponding CLI command.

Built on [`@insoftex/lhremote-core`](../core).

## Installation

End users should install the [`lhremote`](https://www.npmjs.com/package/@insoftex/lhremote) meta-package, which includes both the CLI and MCP server:

```bash
npm install -g @insoftex/lhremote
```

This provides the `lhremote` binary. See the [root README](https://github.com/insoftex-company/insoftex-lhremote#installation) for full details.

Installing `@insoftex/lhremote-cli` directly is possible but provides the `lhremote-cli` binary instead:

```bash
npm install -g @insoftex/lhremote-cli    # binary: lhremote-cli
```

## Usage

```bash
# Detect running LinkedHelper
lhremote find-app --json

# Launch LinkedHelper and show its desktop window on Windows
lhremote launch-app --verbose

# List accounts and start an instance
lhremote list-accounts --cdp-port 9222
lhremote start-instance 1

# Create and run a campaign
lhremote campaign-create --file campaign.yaml
lhremote import-people-from-urls 42 --urls-file targets.txt
lhremote campaign-start 42 --person-ids 100,101,102

# Monitor progress
lhremote campaign-status 42 --include-results
lhremote campaign-statistics 42

# Query results
lhremote query-messages --person-id 100 --json
lhremote check-replies --since 2025-01-01T00:00:00Z
```

## Commands

<!-- GENERATED:CLI_COMMANDS_START -->
The table below is generated from [`packages/cli/src/program.ts`](src/program.ts).

| Command |
|---|
| `find-app` |
| `launch-app` |
| `quit-app` |
| `list-accounts` |
| `list-workspaces` |
| `start-instance` |
| `stop-instance` |
| `restart-instance` |
| `ensure-instances` |
| `list-orphans` |
| `reap-orphans` |
| `campaign-list` |
| `campaign-list-people` |
| `campaign-create` |
| `campaign-get` |
| `campaign-delete` |
| `campaign-erase` |
| `campaign-exclude-list` |
| `campaign-exclude-add` |
| `campaign-exclude-remove` |
| `campaign-export` |
| `campaign-status` |
| `campaign-statistics` |
| `campaign-move-next` |
| `campaign-retry` |
| `campaign-start` |
| `campaign-stop` |
| `campaign-update` |
| `campaign-add-action` |
| `campaign-remove-action` |
| `campaign-update-action` |
| `campaign-reorder-actions` |
| `import-people-from-urls` |
| `collect-people` |
| `campaign-remove-people` |
| `list-collections` |
| `create-collection` |
| `delete-collection` |
| `add-people-to-collection` |
| `remove-people-from-collection` |
| `import-people-from-collection` |
| `describe-actions` |
| `query-messages` |
| `query-profile` |
| `query-profiles` |
| `query-profiles-bulk` |
| `scrape-messaging-history` |
| `visit-profile` |
| `check-replies` |
| `check-status` |
| `get-errors` |
| `dismiss-errors` |
| `get-action-budget` |
| `get-throttle-status` |
| `comment-on-post` |
| `get-post` |
| `get-post-stats` |
| `get-feed` |
| `dismiss-feed-post` |
| `react-to-post` |
| `react-to-comment` |
| `unfollow-from-feed` |
| `hide-feed-author` |
| `hide-feed-author-profile` |
| `unfollow-profile` |
| `get-profile-activity` |
| `build-url` |
| `resolve-entity` |
| `list-reference-data` |
| `search-posts` |
| `message-person` |
| `send-invite` |
| `send-inmail` |
| `follow-person` |
| `endorse-skills` |
| `like-person-posts` |
| `remove-connection` |
| `enrich-profile` |
<!-- GENERATED:CLI_COMMANDS_END -->

See the [root README](https://github.com/insoftex-company/insoftex-lhremote#cli-usage) for full command-line usage.

## Development Notes

`launch-app` delegates lifecycle behavior to `@insoftex/lhremote-core` `AppService`. On Windows, the app is restored and focused through native window management rather than CDP page focus, because the launcher can expose a reachable CDP endpoint without any page targets. See the [Development Specification](../../docs/development-specification.md) for maintenance requirements.

## Programmatic Usage

```typescript
import { createProgram } from "@insoftex/lhremote-cli";

const program = createProgram();
await program.parseAsync(process.argv);
```

## License

[AGPL-3.0-only](https://github.com/insoftex-company/insoftex-lhremote/blob/main/LICENSE)
