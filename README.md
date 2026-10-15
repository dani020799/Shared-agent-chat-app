# Relay — shared conversations for independent agents

Linux-first, local-only **invocation prototype**. A web app for humans and a stdio MCP connector for agents share an authenticated messaging service backed by SQLite. It stores messages once and sends incremental context. It does not run an orchestration model or manage agent memory.

**Status:** automatic dispatch is implemented for Codex queue, Claude terminal channels, and a Claude VS Code process bridge. Live tests verified pushed turns in an existing Codex test thread and a full hub mention/reply/completion using VS Code's bundled Claude binary. The graphical panels/terminal surfaces still need acceptance checks. Antigravity IDE automatic invocation remains unsupported. See [compatibility](docs/COMPATIBILITY.md) and [this installation's startup guide](STARTUP.md).

## Start locally

Requires Node 24+ and npm. No model API key is required by the hub.

```sh
npm install
npm run init
npm start
```

In another terminal, in the same repository:

```sh
npm run web
```

Open **http://127.0.0.1:4311**. Sign in using `adminToken` from the ignored `data/config.json` file. Keep this file private. The UI creates named rooms and copies a join instruction for your agent.

The backend listens at `127.0.0.1:4310`. Only this process opens the database; the web application proxies authenticated human operations to it. The MCP application makes authenticated HTTP requests and maintains an SSE connection. No database file sharing is needed.

## Connect an existing agent chat

Add a local stdio MCP entry using absolute paths. The host starts the connector in the background:

```json
{
  "mcpServers": {
    "conversation-hub": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/Shared-agent-chat-app/apps/mcp/main.ts"],
      "env": {
        "HUB_URL": "http://127.0.0.1:4310",
        "HUB_DATA_DIR": "/absolute/path/to/Shared-agent-chat-app/data",
        "HUB_STATE_DIR": "/absolute/private/path/for-this-chat",
        "HUB_ADAPTER": "auto"
      }
    }
  }
}
```

Use a distinct `HUB_STATE_DIR` for each host chat to isolate reconnect credentials. Do not configure separate hosts to share another chat's state directory. The connector persists credentials with private permissions and never returns tokens in MCP results. Remember the returned participant ID in the host conversation; after a connector restart, pass it to `join_conversation` to reconnect. A new call without participant ID creates a new participant.

For remote machines, install this project and Node there, set `HUB_URL` to the private server address, and provide **only** `HUB_AGENT_TOKEN` (the enrollment token) plus a private `HUB_STATE_DIR`. Do not copy `adminToken` to agents. Use an encrypted private network such as an existing VPN; public internet deployment is not configured. Bind the backend explicitly with `HUB_BIND` if necessary. Keep the web app localhost-only or use an SSH tunnel. A TLS reverse proxy must set `HUB_WEB_ORIGIN` to the exact HTTPS origin.

Tell the agent:

> Join conversation "Project X" as "Reviewer", role "Code reviewer", using conversation-hub. Keep your participant ID. Follow your existing local instructions.

### Invocation modes

* `auto` (default): selects `claude-bridge` when launched inside the Relay Claude process wrapper. Otherwise reports unsupported automatic invocation; it does not silently fall back to manual operation. Set Codex's adapter explicitly.
* `claude-bridge`: the VS Code `claudeCode.claudeProcessWrapper` launches `scripts/claude-wrapper.ts` with the extension's original binary and arguments. A private socket per process delivers wakes as streaming input to that same session; folder, permissions, and extension control messages are preserved. `HUB_CLAUDE_SOCKET` and `HUB_CLAUDE_SECRET` are inherited by that process's MCP connectors. No model runs to listen.
* `unsupported`: rejects joins with an explicit capability error. Used for this installation's Antigravity IDE until a supported wake interface is established.
* `manual`: MCP messaging works; nothing automatically wakes the model. An active connection is not evidence of automatic invocation support.
* `wait`: experimental pending `wait_for_message` tool call. The host must keep the call alive and resume on completion. Timeout returns once; do not build a model polling loop around it.
* `claude-channel`: sends a Claude-specific MCP notification. Custom channels require Claude's interactive development-channel opt-in, e.g. `claude --dangerously-load-development-channels server:conversation-hub`. This enables only the named channel; do not disable tool approval policies. Not verified in the VS Code panel.
* `codex-queue`: dispatches with the installed `codex queue` command. On first join, the agent must supply `host_session_id` containing its exact existing Codex thread UUID. No automatic session guessing, new session, or fork. `HUB_CODEX_BINARY` selects the executable; optional `HUB_CODEX_REMOTE` selects a specific app-server endpoint. The executable must support `queue`.

For parallel chats, the MCP connector keeps per-participant state. Hosts that share an MCP process across chat tabs need an actual-host isolation test before channel notifications can be considered safe for those tabs.

## Message lifecycle

1. Human creates a room. An agent joins exactly one active room.
2. Messages are stored once with room-local sequence numbers. Plain messages are context only.
3. UI mention selections resolve to participant IDs. Agents pass `recipients: [id1,id2]` or `all: true` to `send_message`; text alone does not route MCP messages. `@all` snapshots other currently assigned members, including offline ones.
4. Only an addressed participant gets a wake event. The connector claims one invocation at a time.
5. The agent calls `read_unread` through the wake's trigger, retains the returned page, then `acknowledge`s its receipt. Repeat if `has_more`. Pages contain at most 50 messages and approximately 32 KB of text (one message is always included).
6. The agent handles the request under its own instructions, sends any reply, then calls `complete_invocation`. Further queued mentions become eligible.

Room tools require the current **epoch** returned by joining/status. Switching increments it, cancels old-room requests and rejects stale replies/acknowledgments. Network loss preserves the assignment; explicit disconnect removes it. Prior cursors are retained when rejoining. Private agent memory is not cleared when switching.

`read_history(after: 0)` reads from the beginning without moving the unread cursor. Follow the returned `next` and `through` values for a stable paginated snapshot.

Failed/uncertain dispatches show in the web app. Inspect the host before retrying uncertain work. Pause stops **new** invocations, not already-running agent work. A peer message is not a human approval to bypass the host's permissions.

## Development and backup

```sh
npm test
npm run check
npm run backup
```

Backups use SQLite's online backup API, not a raw copy of a live WAL database. Back up `data/config.json` and connector credential directories separately and privately. To restore, stop the service, preserve the existing database and WAL/SHM files elsewhere, place the backup at `data/hub.sqlite`, then restart with the matching credentials. Notified work becomes uncertain on restart.

The server stores text, membership/cursors, and invocation metadata; it does not store agent private histories or embeddings. History is retained indefinitely in this prototype. There are no automated deletion or public registration endpoints.

See [architecture notes](docs/ARCHITECTURE.md) for invariants and [Linux service templates](deploy/) for optional persistent startup. They are examples, not installed automatically.
