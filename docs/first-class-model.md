# Grok Build as a Pi model

Version 0.1.

Goal: `pi --model grok/<id>` and Fabric `agents.run({ model: "grok/<id>" })` use Grok Build as the model.
Grok runs on its own harness. Its native tools, permission rules, subagents, compaction, and history stay on the Grok side.
Pi drives turns, streams output, records the transcript, and can lend extra tools.

Reason: Grok performs well inside its harness and poorly outside it. The provider keeps the harness.

## Layers

| Layer | Owner | Contract | Evidence |
| --- | --- | --- | --- |
| Model registration | Pi | `pi.registerProvider("grok", { streamSimple })` | Pi 0.87.1 `docs/custom-provider.md` |
| Transcript to prompt | provider | system prompt as `_meta.rules`, newest user text as `session/prompt` | `src/model/provider.ts` |
| Transport | provider | one WebSocket to the gateway, many Grok sessions, routed by `sessionId` | `src/model/connection.ts` |
| Backend | gateway | `grok agent leader` with one native stdio client per WebSocket | `scripts/server.ts` |
| Tool execution | Grok | native tools run inside Grok. `tool_call` updates become Pi thinking blocks `[grok <tool>] ...` | `src/model/session.ts` |
| File edit scheme | Grok config | `[toolset] file_toolset = "hashline"` in `~/.grok/config.toml` selects `hashline_read`, `hashline_edit`, `hashline_grep` | `agent_ops.rs` `override_file_tools`, `config_override.rs` overlay allowlist excludes this key |
| Permissions | Grok asks, Pi answers | `session/request_permission` becomes a Pi dialog. Headless Pi denies | `permissionHandler` in `src/index.ts` |
| Lent Pi tools | optional | `mcpServers: [{ type: "http", url: "<gateway>/mcp/<token>" }]`. The gateway relays each MCP message to the owning Pi socket as `_x.ai/mcp/sdk_call`. Parked until Pi returns the result | `scripts/server.ts` relay, `src/model/session.ts` |
| Output | provider | agent chunks become `text_delta`, thought chunks become `thinking_delta` | ACP |
| Gate | Pi hook | `pre_tool_use`: capability mirror of Pi's tool set, classified by Grok's `x.ai/tool` stamp, plus `denyGrokTools`, `allowGrokTools`, `mcpReadOnlyServers` | `src/model/hooks.ts` `capabilityGate`, `xai-grok-tools/src/tool_taxonomy.rs` |
| Guard | gateway | tiered fail-closed answers for hooks and permission prompts when Pi is slow or gone, driven by `pi/gate-ack` | `scripts/server.ts`, `resolveGuard` in `src/config.ts` |
| Enrich | Pi hook | `post_tool_use` after an edit: syntax check or `postEditCheck`, failure returned as `additionalContext` | `postEditContext` |
| Hold | Pi hook | `stop`: `stopCheck` failure blocks the end of turn with the output as reason | `stopGate` |
| Transcript | Pi session | one `grok-tool` custom entry per native call, rendered by the extension, not in model context | `src/model.ts` |

## Turn mapping

1. Pi calls `streamSimple(model, context)`.
2. First call for a Pi session: `session/new`. Later calls: `session/load` of the stored Grok session.
3. When a lent Pi tool call is parked, the newest tool-result message answers it and the Grok turn continues.
4. Otherwise the newest user message goes out as `session/prompt`.
5. Text, thoughts, and native tool activity stream as Pi events.
6. A lent-tool call ends the Pi assistant message with `toolUse`. Pi runs the tool. The next `streamSimple` resumes the same Grok turn.
7. Prompt completion ends with `stop`. Abort sends `session/cancel` and returns an aborted result.

## Lent tools policy

`piTools` selects what Pi offers: `extensions` (default), `none`, `all`, or a name list.
The default excludes Pi core tools, so Grok's own file and shell tools have no duplicates.
Grok chooses between its own tools and lent ones. In tests it preferred its native `read_file` over `pi__read`.

## Verified

- Live, stock leader, guard (`evidence/gateway-guard-probe.json`): a Pi that never acks a gate was denied by the gateway at the `ackMs` tier (5014 ms, and 3008 ms with a file setting of 3000). A Pi that dropped its socket during a permission prompt: file not created. An acked dialog answered after the ack tier: honored.
- Live, stock leader, MCP gate (`evidence/mcp-gate-probe.json`): in a read-only session an MCP tool with `_meta.readOnlyHint` was allowed and reached its server; an unmarked tool on another server was denied before reaching it, and Grok reported the reason without retrying. Hook `toolName` is the qualified `server__tool`; the stamp is the `use_tool` dispatcher.
- Wire: `_x.ai/mcp/list` returns each tool's `_meta` and drops MCP `annotations` (`xai-grok-mcp/src/servers.rs` copies name, description, schema, `_meta`, icons only).
- Timing (8 alternating runs, `scripts/perm-timing.ts`): hook and permission round trips inside 1 ms; turn totals 7.4 to 10.0 s with no separation between hooks on and off.

- Live, stock leader, hooks (`evidence/hooks-live.json`): a read-only Pi session denied Grok's `hashline_edit` and the file stayed unchanged, with the reason reported by Grok. A broken edit was repaired in the same turn after the syntax-check context. A `stopCheck` blocked the first end of turn until `done.txt` existed.
- Live, stock leader, raw ACP hooks (`evidence/hooks-probe-stock-leader.json`): `pre_tool_use` deny redirected Grok from the shell to `hashline_read`; `post_tool_use` `additionalContext` appeared in the answer; `stop` was consulted.
- Live: `grok-tool` entries with `toolUseId`, input, status, output, and duration persisted in the Pi session file.

- Live, stock leader, HTTP relay: Grok discovered, listed, and called a Pi-only tool through `/mcp/<token>`, waited 5 s for the held result, and answered with the Pi-held token. Unknown token 404, anonymous probe 400, GET 405. `evidence/model-probe-http-stock-leader.json`.
- Live, stock leader, `piTools: all`, `headlessPermissions: allow`: `pi -p --model grok/grok-4.7` completed the read+write task with Grok native `hashline_read` and `write`. `evidence/model-live-gateway-all.json`.
- Live, stock leader, default policy: same task with `run_terminal_command`. `evidence/model-live-gateway-extensions.json`.
- Live, raw ACP: a shell command with a file redirect triggers a permission prompt; a cancelled prompt yields tool status `failed` and `stopReason: cancelled`. A plain `cat` runs without a prompt.

- Live, forked leader gateway, hashline: a one-line change in a four-line file used `hashline_grep` then `hashline_edit` with anchor `3:uoh:irj`. Other lines unchanged. Pi executed zero tools.

- Live, forked leader gateway, default policy: `pi -p --model grok/grok-4.7` read a token and wrote a file with Grok native `read_file` and `search_replace`. Pi executed zero tools. `evidence/model-live-gateway-extensions.json`.
- Live, forked leader gateway: Grok listed and called a Pi-only tool through `_x.ai/mcp/sdk_call`, waited 5 s for the result, and answered with the Pi-held token. `evidence/model-probe-leader.json`.
- Live, direct agent, stock binary: same two checks. `evidence/model-probe-standalone.json`, `evidence/model-live-standalone.json` (older allowlist variant).
- Unit: one Grok turn splits into two Pi assistant messages around a lent tool call. Native tool activity never becomes a Pi tool call. Abort cancels and rejects parked calls. `test/model.test.ts`.

## Leader gap, fork, and the HTTP relay that replaced it

Stock 1.0.41 leader drops in-process `sdk_call`. `SdkCallParams` has no `sessionId`, and `leader/server.rs` discards session-less reverse requests.
Fork branch `pi/sdk-call-session-id` (commit `2201fa2e`, two files) adds the `sessionId` and was verified live. It is kept as a record.

The running design avoids the router instead. Pi registers the lent tools as an HTTP MCP server at the gateway.
Grok's own MCP client (rmcp streamable HTTP) POSTs `server/discover`, `initialize`, `tools/list`, and `tools/call` to `/mcp/<token>`.
The gateway learns `token -> Pi socket` from the `session/new` it forwards, relays each POST as `_x.ai/mcp/sdk_call`, and returns Pi's reply as the HTTP response.
GET answers 405, so rmcp skips the SSE stream. An unknown token answers 404. The anonymous `{}` probe answers 400, not 401, so Grok treats the server as reachable.
The stock binary runs everything. `PI_GROK_BINARY` still selects another build when wanted.

## Permission prompts

Grok asks `session/request_permission` for some native calls, for example a shell redirect that writes a file. A plain `cat` runs without a prompt.
Interactive Pi shows the dialog. Headless Pi answers by `headlessPermissions` (`dialog`, `deny`, `reads`, `allow`).
A cancelled or rejected prompt makes Grok end the turn with `stopReason: cancelled`. The provider maps that to Pi `stop`, and to `aborted` only when Pi itself aborted.

## Open items

- Pi skills under the Grok model. Pi expands `/skill:x` into the user message; the provider sends that text as the `session/prompt`, so Grok receives it as plain user text with no skill marker. Grok's own skill machinery is not involved and not wanted. Expected: instructions and shell commands work as written; Pi core tool names (`edit`, `bash`) need Grok to translate to its own tools; lent extension tools appear as `pi__<name>`. To verify: run one instruction-heavy Pi skill (for example `simple-english`) through `pi -p --model grok/grok-4.7` with skills enabled and check which tools Grok chose. Live checks so far ran with `--no-skills`.
- Images. Verified both ways (`evidence/image-probe.json`, plus a `pi -p @blue.png` run). Outbound: `image_gen` returns `{ type: "ImageGen", path, filename, session_folder }`; the file is a JPEG under `~/.grok/sessions/<encoded cwd>/<grok session>/images/`. The `grok-tool` entry records it as `mediaPath` and the renderer shows a `saved` line. Inbound: Grok's ACP accepts an image block but does not see it (`promptCapabilities.image: false`; a red pixel answered "Unknown"). The provider now spills image blocks to `$TMPDIR/pi-grok-images/<sha>.<ext>` and references the path in the prompt; Grok reads the file with `hashline_read` and answers correctly. The model advertises `input: ["text", "image"]` on that basis.
- Secondary channel: `ask_user_question` handled (`_x.ai/ask_user_question`, four wire outcomes mapped to Pi dialogs, cancelled when headless, gateway `ask:` gate). `/grok plan|goal|compact|info` added. Queue and steering (probed, `scripts/queue-probe.ts`): Pi's `input` event exposes `streamingBehavior` (`undefined` idle, `steer`, `followUp`) and a handler can return `{ action: "handled" }`. On Grok's side, a second `session/prompt` during a turn is queued (`_x.ai/queue/changed`, position 0) and runs as its own turn afterwards: follow-up semantics. `x.ai/interject` (`_x.ai/interject` on the wire, `{ sessionId, text }`) is accepted at once and drains at the next safe point: the running turn ended early (35 of 60 lines), but the interjection's answer did not appear in that turn's stream. Pi `steer` (Enter mid-turn) maps to `x.ai/interject` (`src/model/steer.ts`); the steered text is recorded as a `grok-steer` entry and never enters Pi's queue. Pi `followUp` (Alt+Enter) flows through untouched and becomes the next prompt. The interjection drains into Grok's running turn (verified: no second assistant turn). Commands are never steered. Also open: status-line surfacing of `_x.ai/session/setup` and `mcp/server_status`.
- Gateway resilience: done for the leader. The gateway supervises the leader; on exit it drops bridges and either respawns or adopts a bridge-spawned leader (Grok's `connect_or_spawn`). Verified live twice under the user's session (`kill -TERM $(cat ~/.grok/pi/leader.lock)`): one respawn, one adoption, session continued. Still open: a `systemd --user` unit so the gateway itself restarts on failure or login.
- Tasks (`spawn_subagent`, `get_command_or_subagent_output`, `kill_command_or_subagent`, `monitor`, `scheduler_*`): model tools only. `/grok tasks` and `/grok kill` need a listing method; check for `_x.ai/tasks/*` extension methods first. Last on the list by decision.

## Limits

- Headless Pi (`-p`) denies Grok permission prompts. Grok's own allow rules still apply; gated tools fail and Grok retries or stops.
- When the prompt response carries no usage meta, usage and cost are zero.
- The offered Pi tool list is read once per Grok session.
- Pi's transcript holds Grok tool activity as thinking text, not as structured tool calls.
