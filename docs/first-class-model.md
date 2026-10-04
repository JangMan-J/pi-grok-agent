# Grok Build as a Pi model: design

Version 0.1.8. This page describes the implemented design. For use and settings, see the [README](../README.md) and [usage.md](usage.md).

Goal: `pi --model grok/<id>`, and any Pi caller that selects a model by ID, uses Grok Build as the model.
Grok runs each turn on its own harness. Its native tools, permission rules, subagents, compaction, and history stay on the Grok side.
Pi drives the turns, streams the output, keeps the transcript, gates Grok's tools, and can lend extra tools.

Reason: a Grok Build agent session includes Grok's tool harness. A plain completion API would replace that harness with Pi's tools. This provider keeps the harness.

## Layers

| Layer | Owner | Contract | Source |
| --- | --- | --- | --- |
| Model registration | Pi | `pi.registerProvider("grok", { streamSimple })`, API `grok-acp` | `src/model.ts`, Pi `docs/custom-provider.md` |
| Transcript to prompt | Provider | Pi project/user context as `_meta.rules`, after stripping Pi harness sections (`tools`, `rules`, `docs`, `skills`) that describe unavailable Pi tools. New user messages and unmatched tool results go as `session/prompt`. For a new Grok session, the earlier Pi transcript is rendered as text (last 60,000 characters). | `src/model/provider.ts` |
| Transport | Provider | One WebSocket to the gateway, many Grok sessions, routed by `sessionId` | `src/model/connection.ts`, `src/client.ts` |
| Backend | Gateway | One supervised `grok agent leader`. One `grok agent --leader stdio` bridge for each WebSocket. The gateway binds its port first and acquires a leader second, so a launch that loses its port owns nothing to stop. | `scripts/server.ts`, `test/gateway.test.ts` |
| Tool execution | Grok | Native tools run inside Grok. `tool_call` updates are tracked for hook classification but not rendered as assistant thinking; completed packets render as `grok-tool` entries. | `src/model/session.ts` `onUpdate`, `onHookRun` |
| File edit scheme | Grok configuration | `[toolset] file_toolset = "hashline"` in `~/.grok/config.toml` selects `hashline_read`, `hashline_edit`, `hashline_grep`. Otherwise Grok uses its default file tools. | Grok Build configuration, not this repository |
| Permissions | Grok asks, Pi answers | `session/request_permission` becomes a Pi selection dialog. Headless Pi uses `headlessPermissions`. | `src/model/permissions.ts` |
| Questions | Grok asks, Pi answers | `_x.ai/ask_user_question` becomes one Pi dialog for each question. | `src/model/questions.ts` |
| Lent Pi tools | Optional | `mcpServers: [{ type: "http", url: "<gateway>/mcp/<token>" }]`. The gateway relays each MCP message to the owning Pi socket as `_x.ai/mcp/sdk_call`. The call waits until Pi returns the result. | `scripts/server.ts` `handleMcpHttp`, `src/model/session.ts` `onMcp` |
| Output | Provider | Agent chunks become `text_delta`. Thought chunks become `thinking_delta`. | `src/model/provider.ts` |
| Gate | Pi hook | `pre_tool_use`: `denyGrokTools` first, then `allowGrokTools`, then the capability mirror classified by Grok's `x.ai/tool` stamp, with `mcpReadOnlyServers` for MCP tools. `/grok perms` sets the mirrored capabilities (`yolo` adds edit, write, and shell), so a deny entry wins in every mode. Grok's own `grokMode` and permission prompts are separate. | `src/model/hooks.ts` `capabilityGate`, `src/model/session.ts` |
| Guard | Gateway | `ReverseRequestGuard`: one guarded lifetime for each hook, permission prompt, and question. Tiered fail-closed answers when Pi is slow or gone, driven by `pi/gate-ack`; one answer per request, late Pi answers dropped; `ask` mode moves a hook to the dialog deadline. | `scripts/server.ts`, `resolveGuard` in `src/config.ts`, `test/gateway.test.ts` |
| Enrich | Pi hook | `post_tool_use` after an edit: syntax check or `postEditCheck`. A failure returns as `additionalContext`. | `postEditContext` in `src/model/hooks.ts` |
| Hold | Pi hook | `stop`: a failed `stopCheck` blocks the end of turn with the output as the reason. | `stopGate` in `src/model/hooks.ts` |
| Transcript | Pi session | `grok-tool` entries for completed native calls. Turn usage rides on the assistant message's `usage` (Pi's convention), not a separate entry. Rendered by the extension. Not in model context. | `src/model.ts` |
| Steering | Pi input event | Mid-turn Enter goes to `_x.ai/interject` and is recorded as `grok-steer`. Alt+Enter passes through as a follow-up. | `src/model/steer.ts` |
| Media | Pi hook and message | Media tool results are copied to `mediaDir` and shown after the turn as a display-only `grok-media` message. | `src/model/session.ts` `copyMedia`, `src/model.ts` `flushMedia` |

## Turn mapping

1. Pi calls `streamSimple(model, context)`.
2. The provider renders Grok rules from Pi's system prompt by removing Pi's own harness catalog/rule/doc/skill sections, then adding a short bridge instruction that Grok should use its native tools and only call Pi tools with `pi_`-prefixed schemas.
3. First call for a Pi session: `session/new`. Later calls on the same connection reuse the attached session with no request. `session/load` of the stored Grok session occurs only on attach to a connection that has not attached it yet, for example in a new Pi process or after a reconnect.
4. If a lent Pi tool call is waiting, the newest tool-result message answers it and the Grok turn continues.
5. Otherwise the new user messages go out as `session/prompt`.
6. Text and thoughts stream as Pi events. Native tool activity stays out of assistant thinking and renders as completed `grok-tool` entries.
7. A lent tool call ends the Pi assistant message with `toolUse`. Pi runs the tool. The next `streamSimple` resumes the same Grok turn.
8. Prompt completion ends with `stop`, or `length` for `max_tokens`. Abort sends `session/cancel` and returns an aborted result.

`/grok goal` and `/grok compact` use the same `startPrompt` lifetime as step 4, with a text collector in place of the Pi stream. A command timeout cancels on Grok and frees the session, and the cancelled prompt's late completion is dropped (`test/model.test.ts`).

Grok returns `stopReason: cancelled` both for a Pi cancel and for a rejected permission prompt. The provider maps it to `aborted` only when Pi aborted. Otherwise it maps it to `stop`.

## Tool result visibility

Grok keeps the full result of each native tool in its own context. Native tool activity does not go into Pi's thinking stream. Pi keeps shortened copies in its own entries:

| Place | Limit | Source |
| --- | --- | --- |
| `grok-tool` entry `output` | 8000 characters | `resultText` in `src/model/session.ts` |
| Rendered `grok-tool` line | 100 characters of input. Expanded: 600 characters of output. | `src/model.ts` |

Results of lent Pi tools go to Grok complete, text and image blocks included (`resolveToolResults`).

## Lent tools policy

`piTools` selects what Pi offers: `extensions` (default), `none`, `all`, or a list of names.
Under `extensions` the Pi core tools are never lent (Grok has native equivalents), and neither are blocked
extension/tool surfaces whose tools duplicate or disrupt Grok native harness behavior. Package defaults
(`DEFAULT_BLOCKED_PI_EXTENSIONS` in `src/tool-policy.ts`) are `pi-lens`, `codemode`, and `image-generation`.
`pi-lens` code-navigation tools otherwise shadow Grok's own `read_file`/`grep`/`list_dir`/LSP and pull that
work onto the MCP loopback. `codemode` is a meta-tool that can call other Pi tools. `image-generation` covers
`generate_image`, which overlaps Grok native image/video tools. Users edit blocked extensions with
`/grok extensions block|unblock`, persisted to `blockedPiExtensions` in `grok-ws.json`. Runtime Pi tool
metadata is used when available, so a blocked source or namespace can withhold tools even without a static
registry entry in this package. `all` and a named allow-list ignore blocked extensions. Grok sees lent tools
with `pi_`-prefixed MCP names, mapped back to the original Pi tool names when Pi executes them. Grok chooses
between its own tools and any lent ones.

## Leader routing and the HTTP relay

The design first tried Grok's in-process `sdk_call` channel through the leader. In Grok Build 1.0.41, the leader did not route those calls, because the call parameters carry no session ID. A local Grok fork (branch `pi/sdk-call-session-id`, commit `2201fa2e`) added the session ID. That fork is not published and is not required.

The current design does not use that channel through the leader. Pi registers the lent tools as an HTTP MCP server at the gateway. Grok's own MCP client sends `initialize`, `tools/list`, and `tools/call` as POST requests to `/mcp/<token>`. The gateway learns `token -> Pi socket` from the `session/new` or `session/load` that it forwards. It relays each POST as `_x.ai/mcp/sdk_call` and returns Pi's reply as the HTTP response.

GET gets 405, so Grok's client does not open an event stream. An unknown token gets 404. A request without a JSON-RPC method gets 400, not 401, so Grok treats the server as reachable without an auth challenge. The stock binary runs everything. `PI_GROK_BINARY` selects another build.

## Permission prompts

Grok sends `session/request_permission` for some native calls, for example a shell redirect that writes a file.
Interactive Pi shows the dialog, unless `/grok perms` is `yolo`, which selects allow once. Headless Pi answers by `headlessPermissions` (`dialog`, `deny`, `reads`, `allow`). The default `dialog` cancels without a UI. `yolo` selects allow once without a UI as well.
`grokMode` (`default`, `auto`, `yolo`) goes to Grok as `_meta.autoMode` or `_meta.yoloMode` on `session/new` and `session/load`. Grok decides which prompts it sends in each mode. `/grok perms yolo` does not change `grokMode`. When a prompt still arrives, Pi selects allow once (`permissionAnswer` in `src/model/permissions.ts`).

## Steering

Pi's `input` event gives `streamingBehavior`: `undefined` when idle, `steer` for Enter during a turn, `followUp` for Alt+Enter. The steer handler takes only the `steer` case when a Grok session exists. It sends the text to `_x.ai/interject`, records a `grok-steer` entry, and returns `{ action: "handled" }`, so the text does not enter Pi's queue. Slash commands and empty input pass through. If the interject request fails, Pi queues the text normally and shows a notice.

Unit tests cover this with a mocked Grok (`test/steer.test.ts`). The live effect of an interjection on the running Grok turn has no saved evidence in this repository. See the development record below.

The registered `input` handler acts only while the active model's provider is `grok`. After a switch to another model in the same Pi session, mid-turn Enter goes to that model; the stored Grok session is used again on a switch back. `test/extension.test.ts` drives the registered handler across Grok, another provider, no model, and Grok again. An earlier version checked only for a stored Grok session ID and would have taken the steer after the switch.

## Development record

These observations come from development runs of the scripts in `scripts/`. Their JSON results were written to `evidence/`, which is not in this repository. They are not current proof. Run the probes again for current results ([usage.md](usage.md#live-probes)). Observations about Grok internals come from reading Grok Build source, which is not in this repository.

| Area | Observation at the time | Script |
| --- | --- | --- |
| Native harness | `pi -p --model grok/grok-4.7` read a token and wrote a file with Grok's native tools. Pi executed zero tools. With `piTools: all` and `headlessPermissions: allow`, Grok still used native tools. | `scripts/model-live.sh gateway` |
| Hashline | With the hashline toolset set, a one-line change used `hashline_grep` then `hashline_edit`. Other lines were unchanged. This run used the local Grok fork. | Manual run |
| Lent tools | Grok found and called a Pi-only tool through `/mcp/<token>`, waited 5 s for the held result, and answered with the token that Pi held. | `scripts/model-probe.ts` |
| Guard | A Pi that never acked was denied at the `ackMs` tier (about 5 s, and about 3 s with a setting of 3000). A Pi that dropped its socket during a permission prompt: the file was not created. A dialog answered after an ack was used. | `scripts/gateway-guard-probe.ts` |
| MCP gate | In a read-only session, an MCP tool with `_meta.readOnlyHint` was allowed. An unmarked tool on another server was denied before it reached the server. | `scripts/mcp-gate-probe.ts` |
| MCP metadata | `_x.ai/mcp/list` returned each tool's `_meta` without MCP `annotations`. | `scripts/mcp-list-probe.ts` |
| Hooks | A read-only Pi session denied Grok's edit and the file stayed unchanged. A broken edit was repaired in the same turn after the syntax-check context. A `stopCheck` held the turn until `done.txt` existed. | `scripts/hooks-live.sh` |
| Timing | Hook and permission round trips took less than 1 ms on loopback. Turn totals did not change measurably with hooks on. | `scripts/perm-timing.ts` |
| Images | `image_gen` returned `{ type: "ImageGen", path, filename, session_folder }` with a JPEG under `~/.grok/sessions/`. An ACP image block was accepted but not seen by the model (`promptCapabilities.image: false`). A file path worked. | `scripts/image-probe.ts` |
| Reconnect | The gateway restarted between two turns. Turn 2 reconnected and kept context. In two manual leader stops, the gateway respawned the leader once and adopted a bridge-started leader once. The session continued. The probe targets the default gateway only (port 2419 and a PID file); it is not usable for isolated runs. | `scripts/reconnect-probe.ts`, manual `SIGTERM` to the leader |
| Queue | A second `session/prompt` during a turn was queued by Grok and ran as its own turn afterwards. | `scripts/queue-probe.ts` |
| Interject | `_x.ai/interject` was accepted at once. In a raw ACP run, the running turn ended early, and the interjection's answer was not in that turn's stream. A later note recorded that no second assistant turn followed. These two notes do not settle whether the running turn uses the interjected text. Treat the live steering effect as unverified. | `scripts/queue-probe.ts interject` |

## Open items

- Steering: verify the live effect of an interjection on the running turn.
- Pi skills under the Grok model: Pi expands `/skill:x` into the user message, and Grok receives it as plain text. Grok must translate Pi tool names such as `edit` and `bash` to its own tools. Not yet checked live. Earlier live checks ran with `--no-skills`.
- Media: probe `image_edit` and the video result types. Video shows as a path only.
- Gateway: add a way to restart the gateway on failure or login, for example a user service. Only the leader is supervised now.
- Tasks: Grok's task tools (`spawn_subagent`, `monitor`, and others) are model tools only. A `/grok tasks` command needs a listing method from Grok.
- Pi stream hooks: call `options.onPayload` and `options.onResponse`, as Pi's custom provider guide asks.

## Limits

- When the prompt response carries no usage report, usage and cost are zero.
- The offered Pi tool list is read once for each Grok session.
- Pi's transcript holds Grok tool activity as `grok-tool` custom entries, not as structured tool calls.
- Pi compaction does not change Grok's history. `/grok compact` compacts Grok's history.
