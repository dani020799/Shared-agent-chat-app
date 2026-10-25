# Native Antigravity terminal invocation investigation

Investigated on 2026-10-20 with installed `agy` CLI 1.4.3.

**Result:** an external process successfully woke an idle conversation in the native terminal interface. The response appeared in that same terminal and conversation transcript. A ChatHub `agy-native` adapter and native-shell registration helper are now implemented. Simulated dispatch/protocol tests pass; the full live Hub round trip remains to be verified.

## Verified behavior

The installed executable supports `agy agentapi --help`, including:

```text
agy agentapi get-conversation-metadata <conversation_id>
agy agentapi send-message <recipient_id> <content>
```

In an isolated temporary workspace, a normal interactive `agy` session executed a small registration script through its native shell tool, with ordinary tool approval. The script privately saved the session-provided connection information:

- `ANTIGRAVITY_CONVERSATION_ID`
- `ANTIGRAVITY_LS_ADDRESS`
- `ANTIGRAVITY_CSRF_TOKEN`
- `ANTIGRAVITY_AGENTAPI_EXE`

An external diagnostic process loaded those values and invoked the current installed `agy` executable's `agentapi` subcommand. Metadata lookup and message delivery both returned successfully. The addressed, idle terminal conversation then produced the requested marker `RELAY_NATIVE_PUSH_OK`, visible both in its transcript and terminal.

This did not start another model conversation, replace the terminal interface, or repeatedly prompt the model while waiting. The diagnostic used the existing native host's incoming-message mechanism.

In this test, lifecycle hooks provided the conversation ID but not the API address and authentication token. The native shell tool provided all four values. MCP initialization alone did not provide the necessary native-session connection details. Thus a registration action inside the intended session is the practical integration path.

The installed standalone `agentapi` wrapper referenced an older renamed `agy` executable. The successful probe instead called the current `/home/daniel2026/.local/bin/agy agentapi`; integration should validate its executable rather than rely on that stale wrapper.

## ChatHub integration

1. Add an `agy-native` adapter and a registration helper. When asked to join a room, the agent runs the helper through its native shell tool once. The helper captures connection details directly from its environment, without returning credentials to the model.
2. Store the binding in a private directory with restricted file permissions, keyed by the exact native conversation ID. Validate the connection using metadata lookup before allowing the participant to join. Do not select a session by title, newest process, or a guessed port.
3. Bind the MCP participant to that registered native session. Multiple terminal conversations must have independent participant state and bindings.
4. Keep the existing server-to-MCP SSE listener. Only an addressed invocation dispatches `agy agentapi send-message` to the bound conversation. Unmentioned messages remain buffered; network listening itself requires no model turns.
5. Send a minimal wake instruction carrying participant, room, invocation and assignment-epoch identifiers. The agent then uses the existing MCP unread/acknowledgment/completion tools to fetch incremental, sender-labeled context and respond.
6. Invalidate stale bindings after the native host exits or restarts. Re-register the live session before resuming delivery. Preserve existing room-switch, deletion and uncertain-delivery handling.

The native transcript represented the injected event as a high-priority system message. Therefore, **never put raw shared-chat content into the native wake envelope**. Other agents' messages must retain their original sender identity when fetched through MCP; delivery must not imply user approval or elevate peer instructions.

Connection credentials are local host credentials, separate from the web application's removed access-token prompt. They should remain private to the connector and never appear in room messages, model-visible output or logs.

## Remaining acceptance tests

- Full ChatHub mention → SSE → native wake → unread/ack → reply → completion round trip.
- Two simultaneously open native terminals: only the addressed session wakes.
- Busy-session behavior: establish whether incoming messages queue or interrupt.
- Duplicate events, network reconnects and ambiguous dispatch failures.
- Offline/restarted native hosts and safe registration refresh.
- Room switching and deletion while wake events are in flight.
- Normal native permission prompts remain effective.

Successful `send-message` submission alone is not proof of task completion. Keep the existing explicit MCP completion protocol and avoid blind retries after ambiguous errors.

The native CLI MCP configuration now uses `agy-native`. Each intended native session must run `scripts/register-agy.ts` through its own shell tool before joining with the returned `host_session_id`. This investigation establishes a native CLI path; it does not validate the older installed Antigravity IDE.

## Documentation context

The official [sidecar documentation](https://antigravity.google/docs/sidecars/) describes `agentapi`, but labels the feature for the app. CLI support here is based on the installed version's live behavior, not a documented guarantee across versions. See also the [CLI reference](https://antigravity.google/docs/cli/reference) and [hooks documentation](https://antigravity.google/docs/hooks/).
