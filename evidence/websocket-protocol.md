# Grok Build WebSocket ACP: source-derived contract

## Scope and evidence

This report covers the self-hosted `grok agent serve` transport. It does not cover stdio, the hosted relay, or xAI inference WebSockets.

- Official repository: https://github.com/xai-org/grok-build
- Inspected commit: `f0e3be1100ef5252488e3be8bb0e91cf68d8c305` (`main` at retrieval).
- Commit timestamp: `2026-09-23T16:52:41Z`.
- Local source checkout: `/tmp/pi-grok-ws-source`.
- Installed executable reports: `grok 1.0.41 (4220f3b224a6) [stable]`.
- The source crate also declares `1.0.41`. Its commit differs from the executable's build hash. Exact binary/source equivalence remains unverified.
- `Cargo.lock` pins `agent-client-protocol` to `0.10.4`. The agent advertises ACP protocol version `1`.
- Server source SHA-256: `9419adc44cfd9a0ec304891a743fd9724812e28f54aaff1b54513603ec6c9ba2`.

I inspected source and the installed CLI's version/help output. I did not start a server, submit a prompt, execute fetched code, or change configuration. This is a static protocol finding, not a live interoperability result.

## Exact handshake

| Item | Source-derived behavior |
| --- | --- |
| URL | `ws://127.0.0.1:2419/ws` for the default bind address. The registered route is `GET /ws`. |
| Header authentication | `Authorization: Bearer <secret>` on the HTTP upgrade request. |
| Query authentication | `ws://127.0.0.1:2419/ws?server-key=<URL-encoded-secret>`. The parameter name is exactly `server-key`. |
| Precedence | A header value with the exact `Bearer ` prefix takes precedence over the query parameter. |
| Invalid header token | A wrong `Bearer` token fails even when the query token is correct. |
| Unrecognized header form | A header without the exact `Bearer ` prefix falls through to query authentication. |
| Comparison | The implementation compares the token and configured secret with string equality. It does not trim the token. |
| Rejection | The handler returns HTTP `401` with `Invalid or missing authorization token` before upgrade. |
| Auth frames | No transport authentication frame or JSON-RPC secret exchange follows the upgrade. |
| Subprotocol | The handler does not configure a WebSocket subprotocol. No `Sec-WebSocket-Protocol: acp` requirement appears here. |
| TLS | This server binds a plain TCP listener and calls `axum::serve`. It does not configure TLS in this path. |

The secret comes from `--secret` or `GROK_AGENT_SECRET`. Without either, `get_secret()` generates a 12-character value from a UUID's hexadecimal representation. Startup output prints the secret and a `/ws?server-key=...` URL.

Header authentication avoids placing the secret in the URL. The secret authenticates access to this local agent server. It is separate from the agent's model-provider credentials and ACP account-authentication methods.

### Source excerpts: authentication and route

[server.rs, lines 96–137](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-shell/src/agent/server.rs#L96-L137):

```rust
#[derive(Debug, serde::Deserialize, Default)]
pub(crate) struct WsQueryParams {
    #[serde(rename = "server-key")]
    pub server_key: Option<String>,
}

/// Validate the bearer token from request headers or query parameters.
fn validate_auth(headers: &HeaderMap, query: &WsQueryParams, expected_secret: &str) -> bool {
    if let Some(token) = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
    {
        return token == expected_secret;
    }

    if let Some(ref key) = query.server_key {
        return key == expected_secret;
    }

    false
}
```

The same handler contains:

```rust
    if !validate_auth(&headers, &query, &state.secret) {
        warn!("Unauthorized connection attempt from {}", addr);
        return (
            StatusCode::UNAUTHORIZED,
            "Invalid or missing authorization token",
        )
            .into_response();
    }

    info!("Authenticated WebSocket connection from {}", addr);
    ws.on_upgrade(move |socket| handle_connection(socket, state, addr))
```

[server.rs, lines 621–637](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-shell/src/agent/server.rs#L621-L637):

```rust
    let app = Router::new()
        .route("/ws", get(ws_handler))
        .with_state(state);

    let listener = TcpListener::bind(config.bind_addr).await?;
```

## JSON-RPC framing

A minimal client sends one compact JSON-RPC object per WebSocket text message. There is no envelope, `Content-Length` header, or required trailing newline on the WebSocket message.

The server trims trailing CR/LF characters from incoming messages. It then writes the remaining bytes and one newline into its internal ACP stream. Consequently, pretty-printed JSON with physical newlines is unsuitable. This adapter also passes multiple newline-separated JSON objects into the internal stream, but one object per message is the simplest contract.

The receiver also accepts UTF-8 binary messages. It ignores binary messages that fail UTF-8 decoding. Empty messages and the exact text `ping` are ignored after trailing CR/LF removal. Text `ping` does not produce a text `pong` response in this handler.

The server reads outgoing ACP data one line at a time. Each nonempty line becomes a WebSocket text message without its trailing CR/LF. JSON-RPC responses retain their request IDs. Notifications and agent-to-client requests share the same socket.

WebSocket Ping/Pong control messages are distinct from JSON-RPC. The server sends empty Ping control messages on a 15-second interval. A normal WebSocket library must handle control frames. This application handler does not implement a missed-Pong deadline.

The `8 MiB` constant sizes internal simplex buffers. It is not an advertised maximum WebSocket message size.

### Source excerpts: framing

[server.rs, lines 381–424](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-shell/src/agent/server.rs#L381-L424):

```rust
                Ok(Message::Text(text)) => {
                    let text_str: &str = text.as_ref();
                    let trimmed = text_str.trim_end_matches(['\r', '\n']);
                    // Skip browser keepalive pings (non-JSON text)
                    if trimmed == "ping" || trimmed.is_empty() {
                        continue;
                    }
                    if to_agent_tx.send(trimmed.to_string()).is_err() {
                        break;
                    }
                }
```

[server.rs, lines 554–588](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-shell/src/agent/server.rs#L554-L588):

```rust
            if agent_read_tx.write_all(msg.as_bytes()).await.is_err() {
                break;
            }
            if agent_read_tx.write_all(b"\n").await.is_err() {
                break;
            }
```

```rust
                    let msg = line.trim_end_matches(['\r', '\n']);
                    if !msg.is_empty() && to_ws_tx.send(msg.to_string()).is_err() {
                        break;
                    }
```

[server.rs, lines 426–443](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-shell/src/agent/server.rs#L426-L443):

```rust
                Some(msg) = from_agent_rx.recv() => {
                    if ws_write.send(Message::Text(msg.into())).await.is_err() {
                        break;
                    }
                }
                _ = keepalive.tick() => {
                    if ws_write.send(Message::Ping(vec![].into())).await.is_err() {
                        break;
                    }
                }
```

## Minimal Pi-side connection sequence

These are wire examples, not an implemented or tested Pi provider. The example assumes the server already has the necessary model-provider credentials.

1. Connect to `ws://127.0.0.1:2419/ws` with the Bearer header or `server-key` query parameter.
2. After upgrade, send this single-line WebSocket text message:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}
```

3. Wait for response ID `1` and inspect the agent capabilities and authentication status.
4. Create a session with a working directory on the server machine:

```json
{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/path/to/project","mcpServers":[]}}
```

5. Keep the returned `sessionId` and send a prompt:

```json
{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"<returned-session-id>","prompt":[{"type":"text","text":"Describe the project structure."}]}}
```

6. Dispatch all incoming messages by their JSON-RPC fields.
7. Render `session/update` notifications and handle agent-to-client requests, including permission requests.
8. Match the final prompt response to ID `3`.

Empty `clientCapabilities` avoids advertising client filesystem or terminal services that the adapter does not implement. The server can still require permission decisions. The transport secret does not enable always-approve. This example does not set `_meta.yoloMode`.

## Reconnect contract

The server retains one `MvpAgent` across connections. Session actors and in-flight prompts survive socket disconnects while that agent process remains alive. Each new socket gets a new ACP connection. Work that needs a disconnected client's permission or filesystem service can still fail or stall.

The server uses one mutable notification destination. A new connection replaces that destination, so later notifications flow to the latest connection. This is not a broadcast subscription per client. Concurrent Pi workers cannot assume isolated notification streams from one `serve` instance.

The relay does not keep a transport replay queue. When no destination exists, it drops messages. A failed send clears the destination. Session history recovery is separate from WebSocket frame replay.

Recommended client recovery sequence:

1. Reconnect with the same transport secret.
2. Create fresh JSON-RPC request tracking for the new socket.
3. Send `initialize` again.
4. Send `session/load` for the existing session:

```json
{"jsonrpc":"2.0","id":2,"method":"session/load","params":{"sessionId":"<existing-session-id>","cwd":"/path/to/project","mcpServers":[]}}
```

5. Process history notifications before the load response, then process continuing live updates.
6. Inspect response metadata `x.ai/runningPromptId` for an active prompt.
7. Do not automatically resend an unresolved prompt after disconnect.

The original prompt can still be active. Resending it can duplicate work. The transport has no request-resumption token or WebSocket replay cursor. A client cannot assume that an old request's final response will arrive on the new connection.

Application-level history recovery does support a cursor. A client can retain the last applied notification's `params._meta.eventId`. The next `session/load` request can include `params._meta.cursor` with that value. A recognized cursor replays later persisted events. An absent or unknown cursor causes full replay. A post-cursor tail without required event IDs also causes full replay.

Full replay marks notifications with `_meta.isReplay: true`. Incremental replay treats post-cursor events as live. The client must handle full-replay fallback without duplicating its displayed history. Transient notifications do not enter persisted history. This is not an exactly-once transport or a byte-for-byte frame replay.

`x.ai/runningPromptId` is an application prompt identifier, not the original JSON-RPC request ID. Old agent-to-client requests also remain bound to their original ACP connection. Process restart differs from socket reconnect: a cold load records interrupted work instead of resuming the dead process's execution.

Sources: [load cursor, lines 1101–1105](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-shell/src/agent/mvp_agent/session_setup.rs#L1101-L1105), [cursor resolution, lines 480–545](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-shell/src/session/storage/replay.rs#L480-L545), and [running prompt, lines 1933–1941](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-shell/src/agent/mvp_agent/session_setup.rs#L1933-L1941). Further source ranges appear in `/tmp/pi-grok-acp-review/reconnect-source-notes.md`.

The source does not give the direct client an automatic reconnect policy. Retry timing belongs to the Pi adapter. If persistent-agent startup fails, the server sends a Close frame with `close_code::AGAIN` and reason `persistent agent unavailable`.

### Source excerpts: persistent agent and notification destination

[server.rs, lines 46–49](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-shell/src/agent/server.rs#L46-L49):

```rust
/// Swappable destination for the relay task.
/// Points at the current ACP connection's gateway sender.
/// When no client is connected, the value is `None` and outbound messages are silently dropped.
type RelayDest = Rc<RefCell<Option<mpsc::UnboundedSender<AcpClientMessage>>>>;
```

[server.rs, lines 501–515](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-shell/src/agent/server.rs#L501-L515):

```rust
    let relay_dest_for_task = relay_dest.clone();
    tokio::task::spawn_local(async move {
        while let Some(msg) = gw_rx.recv().await {
            let maybe_tx = relay_dest_for_task.borrow().clone();
            if let Some(tx) = maybe_tx
                && tx.send(msg).is_err()
            {
                *relay_dest_for_task.borrow_mut() = None;
            }
        }
    });
```

[server.rs, lines 539–548](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-shell/src/agent/server.rs#L539-L548):

```rust
    let (conn_gw_tx, conn_gw_rx) = tokio::sync::mpsc::unbounded_channel::<AcpClientMessage>();

    *relay_dest.borrow_mut() = Some(conn_gw_tx);
```

## Source map and limits

All links use the inspected commit rather than mutable `main`.

- [Server transport](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-shell/src/agent/server.rs): authentication, framing, keepalive, persistent agent, route.
- [Serve CLI arguments, lines 348–375](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-pager/src/app/cli.rs#L348-L375): bind, secret, environment variable, generated secret.
- [Startup output, lines 201–214](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-pager-bin/src/main.rs#L201-L214): printed query-auth URL.
- [Serve dispatch, lines 1610–1619](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-pager-bin/src/main.rs#L1610-L1619): actual server setup.
- [ACP initialize response, lines 532–562](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-shell/src/agent/mvp_agent/acp_agent.rs#L532-L562): ACP V1, load-session support, account-authentication methods.
- [Internal line reader](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-acp-lib/src/line_reader.rs#L25-L80): newline-delimited internal stream.
- [Official agent guide](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md): session lifecycle and permission semantics.

Repository-wide searches for `server-key`, `connect_async`, `client_async`, and WebSocket constructors did not identify a dedicated direct `/ws` client implementation. They found the server, its startup URL, and other transports. This is a scoped search result, not proof that no client exists elsewhere.

The server log mentions `--remote`, but that log is not evidence of a working client path. `ServeArgs.remote` exists. The inspected `Serve` dispatch does not consume it. Hosted-relay reconnection behavior cannot establish the direct-server client's behavior.

No live handshake, malformed-message, simultaneous-client, or reconnect probe ran. The decisive implementation check is a client against the installed `1.0.41` server. That check is outside this read-only task's no-launch constraint.
