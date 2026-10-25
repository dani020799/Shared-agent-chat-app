# Invocation compatibility — implementation status

Automatic adapters and the messaging protocol are implemented. Live runtime tests passed on 2026-10-15 as recorded below. The installed graphical host surfaces have not completed the full acceptance procedure; this is not universal automatic wake-up support.

| Surface | Local evidence | Adapter | Actual-host validation |
| --- | --- | --- | --- |
| Codex terminal | Installed `codex-cli 0.162.1` | `HUB_ADAPTER=codex-queue`; configured with absolute binary path and exact existing thread UUID | Real isolated app-server thread processed `queue --remote` push and returned expected reply. Pending: opened terminal display and full hub round trip |
| Claude Code terminal | Installed Claude 2.1.205; documented MCP channel contract | `HUB_ADAPTER=claude-channel` emits `notifications/claude/channel` | Pending: interactive custom-channel opt-in and real session round trip |
| Claude Code VS Code panel | Installed extension 2.1.299; its bundled binary supports streaming input | Private per-process bridge, installed via `claudeCode.claudeProcessWrapper`; MCP uses `auto` | Bundled binary passed real hub mention → SSE → MCP → same session → unread/ack → reply → completion. Pending: panel display and permissions after window reload |
| Antigravity IDE | Found at `/media/daniel2026/1EBA8CABBA8C814F/antigravity/Antigravity IDE`; app 1.107.0, agent extension 0.2.0 | `unsupported`; join explicitly reports missing wake support | No supported incoming-message command established for this installed IDE |
| Antigravity native terminal | Installed `agy` 1.4.3; live probe on 2026-10-20 | Proposed `agy-native`; not yet implemented or enabled | External `agentapi send-message` woke the exact idle native conversation; expected reply appeared in its terminal and transcript. Pending: full ChatHub round trip and concurrent-session checks. [Investigation](ANTIGRAVITY-CLI.md) |
| Grok Build terminal | Installed `grok` 1.0.62; native live test on 2026-10-20 | `grok-monitor`; configured in `~/.grok/config.toml` | Real isolated native terminal passed MCP join → persistent monitor → addressed hub mention → unread/ack → linked reply → completion in the same conversation. Unmentioned context caused no model activity. Two-listener isolation is tested at the adapter boundary; concurrent native terminals, reconnects and busy-turn behavior still need live checks. [Setup and lifecycle](GROK.md) |

Sources: [Claude channels reference](https://code.claude.com/docs/en/channels-reference), [Claude VS Code](https://code.claude.com/docs/en/vs-code), [Antigravity MCP](https://antigravity.google/docs/mcp), [Antigravity sidecars](https://antigravity.google/docs/sidecars/), [Codex App Server](https://learn.chatgpt.com/docs/app-server).

Antigravity's documented `agentapi send-message` sidecar feature is labeled for the **Antigravity app**. It is not evidence that this installed IDE exposes that interface. No private IDE protocol, automated typing, or alternate headless session is used here.

The Claude bridge combines the documented [process-wrapper setting](https://code.claude.com/docs/en/vs-code) and [streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode). It preserves the original host process and tool approvals. Its socket has a process-specific secret in a private temporary directory. Duplicate invocation IDs are suppressed within that process (last 4,096); database acknowledgment remains authoritative across restarts. The wrapper injects a wake instruction containing IDs, not untrusted message bodies; the agent fetches original sender-labeled messages through MCP.

Optional live probes (consume normal model usage): `node scripts/probe-codex-live.ts`, `node scripts/probe-claude-live.ts`, and `node scripts/probe-claude-hub.ts`. Set `HUB_CLAUDE_BINARY` to a specific installed binary when needed. These create dedicated test sessions and do not target existing user conversations. Local test transcripts may remain in the host's history. The Codex probe archives its test thread on success.

## Manual host acceptance procedure

1. Start service and web app. Create a dedicated test room.
2. Configure the MCP server in **two independently opened host chats**, with session-specific connector state directories. Use the same enrollment credential.
3. Each chat calls `join_conversation` with a name and plain-text role. Record distinct participant IDs and each host's actual session ID. Do not reuse another chat's participant ID.
4. Leave both idle for at least two minutes. Confirm no new tool/model turns occur due to listening. SSE heartbeats are ordinary network traffic.
5. Send context without mentions. Neither model should wake.
6. Mention one participant. Confirm only that exact existing host chat wakes. It reads the incremental context with original sender labels, acknowledges it, replies and completes the invocation.
7. Have it mention the other participant. Confirm the second chat wakes, without creating a replacement session.
8. Disconnect the network, send another addressed message, reconnect the same participant and verify backlog delivery.
9. Switch one participant to a second room. Old-room queued notifications, sends and receipts must be rejected. Rejoining can read history but must not revive canceled requests.
10. Repeat for each host surface. Record host versions, timestamps, observed model usage, and invocation IDs. Mark supported only after all steps pass.

The automated tests cover the HTTP/SSE/MCP boundaries and invocation contracts; they do not substitute for this actual-host test.

## Limits of acknowledgment

The server marks a claimed event `notified`, not "the model started". `codex queue` success or writing a Claude channel notification is not proof the model processed it. The agent must acknowledge each page and call `complete_invocation`. Unexpected dispatch errors and interrupted notified jobs become `uncertain`, requiring inspection before retry. This avoids blind duplicate execution but cannot promise exactly-once side effects.

An invocation already handed to a host cannot be recalled. Its wake carries assignment epoch and room ID; subsequent tools reject stale epochs after a room switch. Already-running external work is the host's responsibility.
