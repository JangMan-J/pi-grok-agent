# Leader-backed local WebSocket routing

## Result

This source revision has no native CLI route that exposes the shared leader through a local WebSocket listener.

- `grok agent serve` starts a separate `MvpAgent`. Configuration that enables leader mode does not change this path.
- `grok agent --leader serve` selects the leader, but runs the stdio proxy. It never reaches the WebSocket listener.
- `--leader-socket` selects an IPC socket. It does not enable leader mode or create a WebSocket listener.
- The native local ACP route is `grok agent --leader stdio`. Each process registers as a separate client of the shared leader.
- If WebSocket remains mandatory, a transport adapter is necessary for this revision. The smallest route preserves the native stdio proxy, once per WebSocket client.

These are source findings, not results from a new runtime probe. No servers, network requests, inference, configuration changes, or source changes occurred during this review.

## Scope and evidence notation

Source root: `/tmp/pi-grok-ws-source`.

Verified Git commit: `f0e3be1100ef5252488e3be8bb0e91cf68d8c305`.
Package version: `1.0.41`, from `crates/codegen/xai-grok-version/Cargo.toml:1–6`.

The following aliases keep citations readable. All paths are relative to the source root.

| Alias | File |
|---|---|
| MAIN | `crates/codegen/xai-grok-pager-bin/src/main.rs` |
| CLI | `crates/codegen/xai-grok-pager/src/app/cli.rs` |
| RUNTIME | `crates/codegen/xai-grok-pager/src/agent_runtime.rs` |
| POLICY | `crates/codegen/xai-grok-pager/src/app/mod.rs` |
| WS | `crates/codegen/xai-grok-shell/src/agent/server.rs` |
| APP | `crates/codegen/xai-grok-shell/src/agent/app.rs` |
| RELAY | `crates/codegen/xai-grok-shell/src/agent/relay.rs` |
| IPC | `crates/codegen/xai-grok-shell/src/leader/server.rs` |
| CLIENT | `crates/codegen/xai-grok-shell/src/leader/client.rs` |
| PROTOCOL | `crates/codegen/xai-grok-shell/src/leader/protocol.rs` |
| TRANSPORT | `crates/codegen/xai-grok-shell/src/leader/transport.rs` |
| LOCK | `crates/codegen/xai-grok-shell/src/leader/lock.rs` |

## Command behavior

| Command or setting | Source-defined result |
|---|---|
| `grok agent --no-leader serve` | Local WebSocket listener with its own agent. |
| `grok agent serve`, including `[cli] use_leader = true` | Same standalone listener. `Serve` is ineligible for configuration-based leader selection. |
| `grok agent --leader serve` | Leader-backed stdio proxy, unless confinement vetoes leader mode. No local WebSocket listener on the leader path. |
| `grok --leader-socket PATH agent serve` | Standalone listener. The socket override alone does not select leader mode. |
| `grok --leader-socket PATH agent --leader serve` | Stdio proxy to the selected leader, not a WebSocket proxy. |
| `grok --leader-socket PATH agent --leader stdio` | Intended native ACP stdio proxy to the selected leader. |
| `grok agent leader` | Shared leader with local IPC and an outbound relay connection when relay authentication permits it. |

### Why the explicit flag behaves differently

`RUNTIME:37–50` passes this eligibility condition to the resolver:

```rust
matches!(
    &args.mode,
    None | Some(AgentCmd::Stdio) | Some(AgentCmd::Headless(_))
)
```

`Serve` is absent. However, `POLICY:460–500` resolves explicit flags before eligibility:

```rust
if no_leader_flag { /* false */ }
if leader_flag { /* true */ }
if !eligible { /* false */ }
```

The resolver then checks local configuration, remote policy in release builds, and finally defaults to false. Requested confinement vetoes leader use afterward.

When `use_leader` is true, `MAIN:1413–1455` connects through `connect_or_spawn`. Its mode selection includes:

```rust
Some(AgentCmd::Stdio) => ClientMode::Stdio,
Some(AgentCmd::Headless(_)) | None => ClientMode::Headless,
_ => ClientMode::Stdio,
```

Thus, explicit `--leader serve` reaches the fallback `Stdio` arm. That arm reads stdin and writes stdout (`MAIN:1458–1557`).
It returns at `MAIN:1562`, before normal command dispatch.

The actual `Serve` arm appears later, at `MAIN:1610–1619`. It constructs `ServerConfig` with only `bind_addr` and `secret`, then calls `run_agent_server`.

`CLI:350–362` declares `serve --remote`, with a proxy-mode comment. The `Serve` dispatch never reads that field. It is not an implemented leader proxy in this path.

## Why standalone WebSocket connections lose notification isolation

`WS:610–637` creates server state and binds a TCP listener. The route is `/ws`.

`WS:455–496` constructs one persistent `MvpAgent`. It does not construct a leader client.

`WS:499–516` keeps one mutable notification destination. Each connection calls `setup_acp_connection`, which replaces that destination at `WS:542`:

```rust
*relay_dest.borrow_mut() = Some(conn_gw_tx);
```

Each connection still gets its own `AgentSideConnection` (`WS:546–553`). This explains the supplied observation: both sockets can exchange requests, but the latest connection receives gateway traffic.

This review did not rerun that probe. The source explains the reported result without assuming that WebSocket acceptance implies multi-client notification routing.

## Native commands and configuration

The following commands are proposed commands, not commands executed during this review.

### Explicit shared leader

Start a persistent leader on a dedicated IPC socket:

```sh
grok --no-auto-update \
  --leader-socket "$HOME/.grok/leader-pi.sock" \
  agent leader --relay-on-demand --no-exit-on-disconnect
```

For each independent ACP client, start one native stdio proxy:

```sh
grok --no-auto-update \
  --leader-socket "$HOME/.grok/leader-pi.sock" \
  agent --leader stdio
```

`--leader` belongs on the follower command. `leader` is the subcommand that starts the backend.
`agent --leader leader` encounters the same early stdio fallback rather than starting the intended backend.

Evidence:

- CLI command definitions and option placement: `CLI:255–302,329–394,423–432,722–723`.
- `--leader-socket` becomes `GROK_LEADER_SOCKET`: `MAIN:1761–1762`.
- Both leader and followers use that socket override, including an auto-spawned child: `LOCK:36–84`.
- Native follower connects or spawns: `MAIN:1446`.
- Leader constructs and starts its IPC server: `APP:695–718,774–832`.
- `--relay-on-demand` defers the outbound relay until a headless client requests it: `APP:578–609`.

The dedicated socket avoids accidental attachment to the normal leader. Its parent directory must exist.
`--relay-on-demand` does not make Grok offline. Startup, authentication, settings, and model activity can still use the network.
`MAIN:1258–1304` includes startup settings retrieval. `WS:464–495` also shows authentication and agent startup work.

### Configuration alternative for stdio

The native configuration setting is:

```toml
[cli]
use_leader = true
```

With that setting, `grok agent stdio` can select the leader without `--leader`, subject to the resolver rules.
The reader is `crates/codegen/xai-grok-shell/src/util/config/mcp.rs:1815–1830`.

This setting does not turn `agent serve` into a proxy. Explicit `--leader` is clearer for the follower command.

## If local WebSocket is mandatory

There is no valid native `grok ... serve ...` command for this combination in the inspected revision.
The minimum adapter arrangement is:

```text
WebSocket client A <-> adapter channel A <-> grok agent --leader stdio A --+
                                                                       +-> leader IPC -> shared agent
WebSocket client B <-> adapter channel B <-> grok agent --leader stdio B --+
```

Both follower processes must use the same `--leader-socket` value.
The adapter converts WebSocket text messages to newline-delimited ACP on stdin, and stdout lines to WebSocket messages.
It must keep stderr separate and preserve requests, responses, notifications, reverse requests, and cancellation.

One shared stdio process for all WebSocket clients collapses leader client identity and subscription state.
A suitable existing adapter must provide a separate subprocess and return channel for each logical client.
This review did not select, implement, or runtime-validate an adapter.

Native stdio already handles leader registration, readiness, and reconnect logic.
`MAIN:1470–1562` implements the stream bridge and reconnect/replay path. `CLIENT:320–402` handles registration and readiness.
A direct WebSocket-to-IPC adapter duplicates more protocol behavior.

## IPC framing and client routing

### Wire format

On Unix, the leader uses `UnixListener` and `UnixStream`, not TCP or WebSocket (`TRANSPORT:1–10`).
The Windows implementation uses named pipes (`TRANSPORT:40–63`).

Each IPC frame consists of:

```text
4-byte big-endian payload length | serialized JSON bytes
```

The maximum payload is 64 MiB (`PROTOCOL:8,22–75`).
Registration uses a tagged `register` message. ACP then travels inside an envelope:

```json
{"type":"acp","payload":"<JSON-RPC string>"}
```

The payload is a JSON string, not a nested JSON object (`PROTOCOL:423–440,464–483`).
A plain WebSocket tunnel or newline stream to `leader.sock` is therefore insufficient.

Registration is mandatory. The server imposes a 30-second registration timeout (`IPC:35,2356–2458`).
When `registered.ready` is false, the native client waits for `leader_ready` before forwarding ACP (`CLIENT:320–402`).

### Multiple clients

Each accepted IPC connection gets a distinct client ID and outbound queue (`IPC:1562–1586`).
Requests use namespaced IDs, `clientId|JSON(originalId)`. Replies restore the original ID and return to the correct client (`IPC:375–406,1941–2005`).

Recognized session IDs establish subscriptions. Session-creation responses also establish subscriptions (`IPC:1825–1839,1945–1964`).
Session notifications go to every subscriber (`IPC:2191–2254`).
Clients do not automatically subscribe to every session merely because they share a leader.

The first subscriber becomes the session driver (`IPC:1825–1831`).
Ordinary reverse requests, including filesystem and terminal operations, go only to that driver (`IPC:2177–2221`).
Permission, question, plan-approval, and MCP-elicitation requests go to all session subscribers (`IPC:509–520,2180–2254`).
Pending interactions replay after a joining client's load/resume response (`IPC:2041–2060,2164–2190`).

Selected machine-wide notifications broadcast to all clients (`IPC:468–478,2066–2076`).
Other sessionless notifications retain a last-active-client fallback (`IPC:1819–1824,2284–2320`).
Leader mode fixes session routing, not every conceivable notification isolation case.

## Pitfalls

1. `--grok-ws-url` changes the outbound relay target. It does not create an inbound listener. `RELAY:372–410,436–438` constructs a client request and connects outward.
2. A local relay implementation still requires another server. Changing the relay URL alone does not expose leader sessions to local WebSocket clients.
3. The default socket name depends on the relay URL. An explicit socket override bypasses that suffix (`LOCK:13–84`).
4. Driver ownership remains with the first subscriber until disconnect. Another subscriber then inherits ownership (`IPC:1662–1687,1825–1831`).
5. The stdio proxy initially advertises `terminal`, `fs_read`, and `fs_write` as false (`MAIN:1434–1445`). Do not assume client-side tool capabilities from transport choice alone.
6. The last subscriber's disconnect sends an internal session-eviction notification (`IPC:1692–1701`). Keeping the leader alive does not itself preserve every attached session actor.
7. Without `--no-exit-on-disconnect`, the leader exits after its last client disconnects (`IPC:1704–1707`).
8. A WebSocket adapter needs an explicit reconnect lifecycle. Ending the stdio process ends its IPC identity and subscriptions.
9. Live events buffer during load/resume, with a 4096-event cap. Overflow loses the ordering guarantee (`IPC:38–41,2006–2040,2223–2239`).
10. IPC client queues are unbounded (`IPC:1565`). A slow adapter must not assume that leader queues provide bounded backpressure.
11. Shared interaction requests can reach several subscribers. The routing layer forwards responses without arbitrating competing answers (`IPC:375–392,1888–1913`).
12. Requested confinement can disable leader mode even with `--leader` (`POLICY:487–493`). Command intent alone does not prove attachment.

## Verification and limits

The analysis traced command resolution through both dispatch branches, WebSocket agent construction, IPC startup, framing, and per-client routing.
A separate read-only worker traced IPC subscriptions and reverse requests against the same commit.

Source tests cover two-client notification broadcast, driver-only filesystem requests, and shared questions:
`crates/codegen/xai-grok-shell/src/leader/server_tests.rs:3459–3553`.
These tests were read, not executed, because they start local servers.

The negative finding is scoped to this first-party revision and these native CLI paths. It does not claim that newer releases or external adapters lack the feature.
No executable behavior was validated during this source-only review. No build was necessary to establish the dispatch and routing findings.
