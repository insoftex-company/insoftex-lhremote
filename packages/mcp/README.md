# @insoftex/lhremote-mcp

MCP server for [lhremote](https://github.com/insoftex-company/insoftex-lhremote) — LinkedHelper automation toolkit.

This package exposes the full LinkedHelper automation surface as a [Model Context Protocol](https://modelcontextprotocol.io) server. AI assistants (Claude, etc.) connect over stdio and use the registered tools to control LinkedHelper.

Built on [`@insoftex/lhremote-core`](../core).

## Installation

```bash
npm install @insoftex/lhremote-mcp
```

## Usage with Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "lhremote": {
      "command": "npx",
      "args": ["@insoftex/lhremote", "mcp"]
    }
  }
}
```

## Programmatic Usage

```typescript
import { createServer } from "@insoftex/lhremote-mcp";

const server = createServer();
// server is a fully configured McpServer with all tools registered
```

Or start the stdio transport directly:

```typescript
import { runStdioServer } from "@insoftex/lhremote-mcp/stdio";

await runStdioServer();
```

## Registered Tools

<!-- GENERATED:MCP_TOOLS_START -->
The table below is generated from [`packages/mcp/src/tools/`](src/tools).

| Tool |
|---|
| `add-people-to-collection` |
| `build-linkedin-url` |
| `campaign-add-action` |
| `campaign-clone-action` |
| `campaign-create` |
| `campaign-delete` |
| `campaign-erase` |
| `campaign-exclude-add` |
| `campaign-exclude-list` |
| `campaign-exclude-remove` |
| `campaign-export` |
| `campaign-get` |
| `campaign-import-from-source-url` |
| `campaign-list` |
| `campaign-list-people` |
| `campaign-move-next` |
| `campaign-remove-action` |
| `campaign-remove-people` |
| `campaign-reorder-actions` |
| `campaign-retry` |
| `campaign-start` |
| `campaign-statistics` |
| `campaign-status` |
| `campaign-stop` |
| `campaign-update` |
| `campaign-update-action` |
| `campaign-validate-action-settings` |
| `cancel-operation` |
| `check-replies` |
| `check-status` |
| `collect-people` |
| `comment-on-post` |
| `create-collection` |
| `delete-collection` |
| `describe-actions` |
| `dismiss-errors` |
| `dismiss-feed-post` |
| `endorse-skills` |
| `enrich-profile` |
| `ensure-instances` |
| `find-app` |
| `follow-person` |
| `get-action-budget` |
| `get-errors` |
| `get-feed` |
| `get-operation` |
| `get-post` |
| `get-post-engagers` |
| `get-post-stats` |
| `get-profile-activity` |
| `get-throttle-status` |
| `hide-feed-author` |
| `hide-feed-author-profile` |
| `import-people-from-collection` |
| `import-people-from-urls` |
| `launch-app` |
| `like-person-posts` |
| `list-accounts` |
| `list-collections` |
| `list-linkedin-reference-data` |
| `list-operations` |
| `list-orphans` |
| `list-workspaces` |
| `message-person` |
| `query-messages` |
| `query-profile` |
| `query-profiles` |
| `query-profiles-bulk` |
| `quit-app` |
| `react-to-comment` |
| `react-to-post` |
| `reap-orphans` |
| `remove-connection` |
| `remove-people-from-collection` |
| `resolve-linkedin-entity` |
| `restart-instance` |
| `scrape-messaging-history` |
| `search-posts` |
| `send-inmail` |
| `send-invite` |
| `start-instance` |
| `stop-instance` |
| `unfollow-from-feed` |
| `unfollow-profile` |
| `visit-profile` |
<!-- GENERATED:MCP_TOOLS_END -->

See the [root README](https://github.com/insoftex-company/insoftex-lhremote#mcp-tools) for parameter details on each tool, and the [MCP Agent Capabilities guide](../../docs/mcp-agent-capabilities.md) for recommended agent workflows.

## Exports

| Export | Description |
|--------|-------------|
| `createServer()` | Create a configured `McpServer` with all tools registered |
| `runStdioServer()` | Start the MCP server on stdio (from `@insoftex/lhremote-mcp/stdio`) |

## License

[AGPL-3.0-only](https://github.com/insoftex-company/insoftex-lhremote/blob/main/LICENSE)
