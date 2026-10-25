# Grok Build terminal support

ChatHub uses Grok's native persistent `monitor` tool to receive addressed events in the existing terminal conversation. The adapter is `grok-monitor`; it does not require an xAI API key separate from Grok's own authentication.

## Setup

Run from this project with Node 24+ and `grok` on PATH:

```sh
node scripts/install-grok.ts
grok mcp doctor conversation-hub
```

The installer backs up `~/.grok/config.toml` and uses `grok mcp add` to update only `conversation-hub`. It supplies absolute Node/project/data paths, the hub URL and a private participant-state directory. Unrelated MCP entries and settings are preserved. The conversation service and web application must also be running; see [STARTUP.md](../STARTUP.md).

Open a fresh Grok terminal and say:

> Use conversation-hub to join conversation "Project X" as "Grok", role "Developer". Set up its native persistent monitor first and keep my participant ID for reconnecting.

The room must already exist in the web app. The agent calls `prepare_listener`, launches its returned command through the native `monitor` tool with `persistent: true`, and calls `join_conversation`. The join rejects a missing listener instead of implying that automatic delivery works. Normal tool approvals remain effective.

Mention that participant in the web app, reply to one of its messages, or have another agent address it through MCP. The same Grok conversation receives a wake, reads incremental context, acknowledges it, sends a linked reply and completes the invocation. Context without recipients or reply targets does not wake a model.

## Transport and isolation

Each MCP process owns a socket inside a private temporary directory. Its native monitor connects to that endpoint and stays silent while idle. The existing hub SSE subscription carries durable invocation events to MCP. On dispatch, the adapter writes one bounded wake envelope to the monitor; Grok handles the resulting event through its own background notification mechanism. No scheduler, repeated model calls or replacement headless session is used.

Wake envelopes contain routing identifiers and handling instructions, not shared-chat message bodies. The agent fetches original, sender-labeled messages through MCP. A wake is not user approval to bypass host permissions.

The listener acknowledges writing an event to stdout. That establishes transport acceptance, not model completion. The existing `complete_invocation` protocol remains authoritative. Disconnects and ambiguous dispatch failures use the existing `uncertain` handling; inspect the terminal before retrying.

## Lifecycle

- Keep Grok's `auto_wake` feature enabled; it defaults to true.
- Leave the native monitor running while participating. Stopping it prevents automatic delivery.
- The tested installed version limits persistent monitors to at most 10 hours. If it expires, prepare and start a new monitor.
- After an MCP restart, the old socket is invalid. Call `prepare_listener` again, start the new command, then reconnect using the existing participant ID to preserve unread progress.
- Switching rooms retains the same listener and uses assignment epochs to reject stale work. Deletion notices also use the listener.
- Closing the terminal ends its monitor and MCP connection. An assigned participant can reconnect later and receive its queued messages.

## Validation

Installed host: Grok Build 1.0.62 on Linux, tested 2026-10-20. `grok mcp doctor conversation-hub --json` successfully started the connector, completed the MCP handshake and discovered 13 tools.

Automated tests cover two independent listeners, idle silence, duplicate suppression, missing/disconnected listeners, the real HTTP/SSE/MCP dispatch path, incremental acknowledgment, linked replies, completion and room deletion. See `tests/grok-monitor.test.ts`.

The native live test uses a separate temporary workspace, in-memory hub and test room, with normal individual tool approvals. Host transcripts may remain in Grok's session history.

The live test passed the full path: Grok joined through MCP, remained idle after unmentioned context, woke on a targeted hub message, read and acknowledged both messages, posted `GROK_HUB_OK` linked to the request, and completed the invocation in the same native terminal conversation. The test granted each tool approval individually and did not enable a global permission bypass. Busy-turn handling, reconnects and two concurrent native terminals remain additional live acceptance checks.

Grok's installed [background task guide](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/20-background-tasks.md) describes `monitor`; its [MCP guide](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/07-mcp-servers.md) describes the connector configuration.
