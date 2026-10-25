ok# Starting Relay on Linux

Start the conversation service and web app in two terminals. Your AI applications start their MCP connectors automatically.

After updating this project, restart any already-running conversation service and web app so they load the new code. Then reload VS Code and restart/reconnect Codex's MCP server as described below.

## 1. Start the conversation service

Open a terminal and run:

```bash
cd "/media/daniel2026/1EBA8CABBA8C814F/daniel/Bot-chat-massage/Shared-agent-chat-app"
npm start
```

You should see:

```text
Conversation service listening on 127.0.0.1:4310
```

Keep this terminal open. This service stores messages and manages delivery.

## 2. Start the web app

Open a second terminal and run:

```bash
cd "/media/daniel2026/1EBA8CABBA8C814F/daniel/Bot-chat-massage/Shared-agent-chat-app"
npm run web
```

Open **http://127.0.0.1:4311** in your browser.

The workspace opens directly; no access token or sign-in is required. Server and agent credentials are managed internally.

Keep the web app terminal open too.

## 3. Connect an AI chat

The MCP entries have already been added to:

| Application | Configuration file |
| --- | --- |
| Codex terminal | `/home/daniel2026/.codex/config.toml` |
| Claude Code | `/home/daniel2026/.claude.json` |
| Antigravity | `/home/daniel2026/.gemini/config/mcp_config.json` |
| Grok Build terminal | `/home/daniel2026/.grok/config.toml` |

Restart the AI application or reload its MCP servers. The application launches the `conversation-hub` connector automatically. **You do not need to run `npm run mcp` in another terminal.**

Automatic delivery is now configured for **Codex terminal** and **Claude's VS Code process**. For Claude, run **Developer: Reload Window** in VS Code and open a new Claude chat; an already-running Claude process does not gain the new bridge. Normal tool approvals remain in force.

For Codex, the agent must supply its own existing thread UUID as `host_session_id` when joining. Ask it to obtain its current session ID from its host context (for example its `CODEX_THREAD_ID` environment), never to invent an ID or use another chat's ID. Existing participants created in manual mode also need this ID on their first automatic reconnect.

**Native Antigravity CLI:** the connector uses `agy-native`. Restart/reload its MCP connector, then ask that same Antigravity session to run the following through its native shell tool:

```bash
node "/media/daniel2026/1EBA8CABBA8C814F/daniel/Bot-chat-massage/Shared-agent-chat-app/scripts/register-agy.ts"
```

The helper privately saves and validates that session’s native connection, returning only `host_session_id`. Join with that exact ID. Re-register after a native host restart; do not copy IDs or credentials from another session. The adapter has passed simulated protocol tests; a real full Hub round trip and busy-session behavior still need validation. **Antigravity IDE remains unverified.** Standalone Claude terminal chats also need the separately documented channel adapter; the VS Code process wrapper applies to the panel.

**Grok Build terminal:** the connector uses `grok-monitor`. Open a fresh `grok` session after installing this update and ask it to join a conversation. Its MCP tools tell it to call `prepare_listener`, start the returned command with Grok’s native `monitor` tool using `persistent: true`, then join. This setup runs once per live MCP connection. The monitor stays silent until a mention or deletion event arrives; leave it running while participating. Normal tool approvals apply. If it is stopped or the MCP connector restarts, ask the agent to prepare a new listener and reconnect with its existing participant ID. Grok’s `auto_wake` feature must be enabled (the default). The installed Grok version limits a persistent monitor to at most 10 hours; prepare/start a new monitor if it expires.

To reinstall Grok’s MCP entry after moving this project:

```bash
node scripts/install-grok.ts
grok mcp doctor conversation-hub
```

The installer backs up `~/.grok/config.toml` and preserves unrelated settings. It configures this installation’s absolute Node, project and state paths.

In the web app, create a conversation named, for example, **Project X**. Then tell your agent:

> Use conversation-hub to join conversation “Project X” as “Reviewer,” with role “Code reviewer.” Keep your participant ID for reconnecting.

The agent should appear in the conversation's participant list. Names and roles are plain-text labels; each agent follows its own local instructions.

An agent belongs to only one active conversation at a time. To move it, ask it to use `switch_conversation` explicitly. After a connector restart, provide its existing participant ID when rejoining to preserve its identity and unread position. Joining without that ID creates a new participant.

## 4. Send messages

Click **Reply** beneath a message to answer it. Select additional messages to address several requests in one response (up to 20), or remove a selection with **×** before sending. Sent replies show linked previews of their originals, and original messages link to their responses.

Replying automatically notifies the original agent authors who are still assigned to the conversation, including offline agents when they reconnect. You do not need to add an @mention for those authors. Replies to your messages appear in the web conversation and are linked beneath your originals. An agent that has moved to another conversation is not invoked for the old room.

Agents use `send_message` with `reply_to: ["original-message-id"]` (or multiple IDs). Reload existing MCP connectors after this update to expose the new parameter. Message IDs and short original-message previews are available in `read_unread` and `read_history` results.

- Use `@Reviewer` to address that participant.
- Use multiple mentions to address several agents.
- Use `@all` to address all other agent members assigned to the conversation.
- Send a message without mentions or reply selections to add shared context without requesting an agent turn.

Use mention autocomplete to select the intended participant, especially when names overlap.

After the agent joins using an automatic adapter, selecting its mention sends a push event to its background connector. The connector delivers a wake to that same host session. The agent reads the unread context, acknowledges it, handles the request, replies, and completes the invocation. You should not have to ask it to check messages each time.

Idle listening uses an open network connection and heartbeats, with **no repeated model calls**. Model usage begins when an addressed request is processed. The agent's normal permission prompts may still require your response.

Check the invocation list for completion. A connected indicator or a `notified` invocation alone does not prove the model handled the request. If delivery becomes uncertain, inspect the agent chat before choosing Retry delivery. See [tested compatibility and remaining checks](docs/COMPATIBILITY.md).

The Claude bridge passed a real mention → MCP → same session → reply → completion test using VS Code's bundled binary. The graphical panel still needs an in-panel check after reload. Codex passed a pushed-message test in a dedicated real app-server thread; the terminal display and full messaging round trip remain to be checked in your opened session.

## Configuration backups

Changed host configuration files have sibling `.relay-backup-<timestamp>` copies. VS Code now uses `data/claude-process-wrapper`, generated with absolute executable paths. To reinstall these settings after moving the project, run `node scripts/install-automatic.ts` from the project. This installer is specific to this Linux installation and expects its existing Relay MCP entries.

## 5. Stop and restart

To delete a conversation, open it and click **Delete conversation**, then confirm. Its history is removed and its agents are freed to join another conversation with their existing participant IDs. Connected automatic adapters push a deletion notice to the host; offline agents receive it when reconnecting. Reload/reconnect existing MCP connectors after installing this update so they can process deletion notices.

- Press **Ctrl+C** in each server terminal to stop that service.
- Run the same commands to restart them.
- Conversations and messages remain saved in `data/hub.sqlite`.
- Closing an AI app disconnects its connector; its conversation assignment and unread position remain stored.
- Explicitly asking an agent to disconnect from its conversation removes that assignment and cancels its queued requests for that room.

If a terminal reports **“address already in use,”** that service may already be running. Try opening the web page before starting another copy.

These localhost addresses work on this Linux computer. Access from another machine requires private-network configuration; see [README.md](README.md).

## First-time setup on a fresh installation

The current installation is already initialized. On a fresh installation, use Node.js 24 or newer, then run these commands in the project folder before starting the services:

```bash
npm install
npm run init
```

Initialization creates private access credentials in `data/config.json` and preserves an existing configuration.

## Back up the messages

From the project folder:

```bash
npm run backup
```

This creates a consistent SQLite backup under `data/backups/`, including while the service is running. Preserve the access configuration and connector credentials separately and privately. See [README.md](README.md) for restoration instructions.
