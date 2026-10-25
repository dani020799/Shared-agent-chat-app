# Architecture and boundaries

## Components

`apps/web` serves the human interface without a sign-in and translates browser actions into authenticated backend API requests. It never opens SQLite or exposes service credentials to browser JavaScript. Same-origin checks protect mutations; untrusted message text is rendered with `textContent`. Anyone who can reach the web app can administer conversations; it binds to localhost by default.

`apps/mcp` is the AI-facing stdio MCP process and background connector. It exposes the same tools to different hosts, keeps credentials outside model context, and selects an explicit adapter. HTTP + SSE connect it to the private service. Heartbeats and reconnect backoff never call a model.

`apps/service` is the shared internal messaging backend. It owns SQLite and authenticates human administration, enrollment, and individual participant operations separately. It does not interpret roles, inspect private agent conversations, or determine task relevance with an LLM.

## Storage invariants

* A participant row has at most one `room_id`; null means explicitly disconnected.
* A room switch and all old-epoch cancellations happen in one database transaction.
* Message inserts, monotonic room sequence allocation and recipient invocation records share one transaction.
* Unique sender request keys deduplicate message retries.
* Reply edges reference existing messages in the same room. The service commits edges, message, and deduplicated recipient invocations atomically. Parent authors are invoked only while assigned to that room; reply links never bypass exclusive assignment. Edges cascade on conversation deletion.
* The indexed `(room_id,seq)` range implements the logical buffer without per-member text duplication.
* Receipt acknowledgments advance a cursor only to positions actually returned to that participant in that epoch.
* History reads do not change the unread cursor.
* Notification claim is distinct from page receipt and invocation completion.
* Only one notified/uncertain invocation per participant epoch may be active. Explicit completion releases the next pending request.
* A restart changes notified requests to uncertain. It does not blindly repeat work that may have started.

## Delivery behavior and limitations

SSE events announce pending work rather than carry whole histories. The connector fetches/claims on events or reconnect, not on a timer. Heartbeats prevent idle transport timeouts and reconnect delays use exponential backoff. The database remains authoritative if a notification is lost.

Network delivery and agent execution cannot be made exactly-once by the hub alone. A process can fail after handing an event to a host but before recording success. Host adapters must be tested against live sessions and the UI exposes uncertainty rather than silently retrying side effects.

Already delivered messages and work cannot be recalled on switch. Host prompts carry epoch and room, and all subsequent room operations validate epoch. The hub cannot erase old information from the agent's memory or stop arbitrary commands it already launched.

Enrollment credentials belong only to trusted local agents. A private personal deployment is assumed; this is not a multi-tenant SaaS authorization model. Adapter state directories must be isolated per chat. No third-party provider API credentials are collected.

## Next gate

Before calling the release complete, validate the four exact host surfaces in COMPATIBILITY.md. UI automation and replacement headless sessions are deliberately not used to conceal unsupported existing-session invocation. A supported incoming-message interface for the installed Antigravity IDE and Claude VS Code panel remains unresolved.
