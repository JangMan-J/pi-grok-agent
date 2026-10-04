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
| Transcript to prompt | Provider | Pi project/user context as `_meta.rules`, after stripping Pi harness sections (`tools`, `rules`, `docs`) that describe unavailable Pi tools. Pi's skill catalog keeps only the skills outside `.agents/skills`: Grok lists that shared directory itself and does not search Pi package directories (skill locations in the documentation bundled with Grok Build 1.0.46). New user messages and unmatched tool results go as `session/prompt`. For a new Grok session, the earlier Pi transcript is rendered as text (last 60,000 characters). | `src/model/provider.ts` |
| Transport | Provider | One non-detached `grok --permission-mode default agent --no-leader stdio` child, many sessions routed by `sessionId` | `src/model/connection.ts` |
| Tool execution | Grok | Native tools run inside Grok. `tool_call` updates are tracked for hook classification but not rendered as assistant thinking. Routine completions batch into one `grok-tools` row per `toolBatchSize`, while failures, denials, media, and post-edit notes keep their own `grok-tool` rows. A single row first writes the calls batched before it, so rows keep call order. Leftovers flush at turn end, before tree navigation, and at session shutdown. | `src/model/session.ts` `onUpdate`, `onHookRun`, `src/tool-batch.ts`, `src/model.ts`, `test/extension.test.ts` |
| File edit scheme | Grok configuration | `[toolset] file_toolset = "hashline"` in `~/.grok/config.toml` selects `hashline_read`, `hashline_edit`, `hashline_grep`. Otherwise Grok uses its default file tools. | Grok Build configuration, not this repository |
| Permissions | Grok asks, Pi answers | `session/request_permission` becomes a Pi selection dialog. Headless Pi uses `headlessPermissions`. | `src/model/permissions.ts` |
| Questions | Grok asks, Pi answers | `_x.ai/ask_user_question` becomes one Pi dialog for each question. | `src/model/questions.ts` |
| Lent Pi tools | Optional | Default: in-process HTTP MCP on `127.0.0.1:<ephemeral>/mcp/<serverId>`. Temporary `PI_GROK_MCP=sdk` path exists for one live probe. | `src/model/mcp-server.ts`, `src/model/session.ts` `onMcp`, `test/transport.test.ts` |
| Output | Provider | Agent chunks become `text_delta`. Thought chunks become `thinking_delta`. | `src/model/provider.ts` |
| Gate | Pi hook | `pre_tool_use`: `denyGrokTools` first, then `allowGrokTools`, then the capability mirror classified by Grok's `x.ai/tool` stamp, with `mcpReadOnlyServers` for MCP tools. `/grok perms` sets the mirrored capabilities (`yolo` adds edit, write, and shell), so a deny entry wins in every mode. Grok's own `grokMode` and permission prompts are separate. | `src/model/hooks.ts` `capabilityGate`, `src/model/session.ts` |
| Guard | Pi process | One answer per hook, permission, or question; fail-closed on orderly close; late answers suppressed. No timers or ack tiers. | `src/model/guard.ts`, `test/transport.test.ts` |
| Enrich | Pi hook | `post_tool_use` after an edit: syntax check or `postEditCheck`. A failure returns as `additionalContext`. | `postEditContext` in `src/model/hooks.ts` |
| Hold | Pi hook | `stop`: a failed `stopCheck` blocks the end of turn with the output as the reason. | `stopGate` in `src/model/hooks.ts` |
| Transcript | Pi session | `grok-tools` batch entries for routine native calls, `grok-tool` entries for the interesting ones. Turn usage rides on the assistant message's `usage` (Pi's convention), not a separate entry. Rendered by the extension. Not in model context. | `src/model.ts` |
| Steering | Pi input event | Mid-turn Enter goes to `_x.ai/interject` and is recorded as `grok-steer`. Alt+Enter passes through as a follow-up. | `src/model/steer.ts` |
| Media | Pi hook and message | Media tool results are copied to `mediaDir` and shown after the turn as a display-only `grok-media` message. | `src/model/session.ts` `copyMedia`, `src/model.ts` `flushMedia` |

## Turn mapping

1. Pi calls `streamSimple(model, context)`.
2. The provider renders Grok rules from Pi's system prompt by removing Pi's own harness catalog/rule/doc sections, then adding a short bridge instruction that Grok should use its native tools, with a list of the lent Pi tools under the `pi__<name>` names that `use_tool` accepts.
3. First call for a Pi session: `session/new`. Later calls on the same connection reuse the attached session with no request. `session/load` of the stored Grok session occurs only on attach to a connection that has not attached it yet, for example in a new Pi process or after a reconnect. Grok's session guide says clients can load a previous session by ID (`~/.grok/docs/user-guide/17-sessions.md`). That `--no-leader` reload is still an unverified live check.
4. If a lent Pi tool call is waiting, the newest tool-result message answers it and the Grok turn continues.
5. Otherwise the new user messages go out as `session/prompt`.
6. Text and thoughts stream as Pi events. Native tool activity stays out of assistant thinking; routine completions render as `grok-tools` batch rows (leftovers flush at turn end), the interesting ones as `grok-tool` rows.
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
| Rendered `grok-tools` batch line | `N calls (2 read_file · 1 grep)` plus total ms. Expanded: one line per call (100 chars input) with 200 chars of output each. | `src/model.ts`, `src/tool-batch.ts` |

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
registry entry in this package. `all` and a named allow-list ignore blocked extensions. The MCP server is
named `pi`, so Grok's model calls a lent tool through `use_tool` as `pi__<name>`. Grok admits an MCP tool
only when that qualified name has one `__`, no `___`, and a tool name of ASCII letters, digits, `_`, and `-`
(`qualify_mcp_tool_name`, as described in the documentation bundled with Grok Build 1.0.46), so
`createPiToolRoutes` in `src/tool-policy.ts` lists a Pi name such as `mcp__docs__search` as `mcp_docs_search`
and maps the call back. The connection routes MCP messages by server ID, not by session ID, so a
`tools/list` that arrives while `session/new` is still pending reaches Pi (`test/transport.test.ts`, with the
fake Grok). Whether the real Grok lists tools before `session/new` returns is unverified. Grok chooses between its own tools and any lent ones.

## Direct agent lifetime and HTTP MCP

Grok Build 1.0.46's user guide documents `grok agent stdio` as the local ACP integration path for custom tools and ACP SDKs (`~/.grok/docs/user-guide/15-agent-mode.md`, section "stdio transport"). This package follows that path (`src/model/connection.ts`): one non-detached child, `grok --permission-mode default agent --no-leader stdio`. The guide's example passes `--always-approve`; this child does not. The child env sets `GROK_DISABLE_AUTOUPDATER=1`. The same release's headless guide says SDKs inject that for the non-leader agents they spawn (`~/.grok/docs/user-guide/14-headless-mode.md`). There is no leader supervision, lock file, or shared agent. `drop()` ends this child; the next `open()` starts another. A new Pi process resumes a stored Grok ID with `session/load`. Sessions are persisted on disk under `~/.grok` regardless of transport (the harness analysis calls this “notes in a filing cabinet”). The session guide says the agent persists session updates and that clients can reconnect and load previous sessions by ID, independent of transport (`~/.grok/docs/user-guide/17-sessions.md`). Whether a fresh `--no-leader` child still has that history after a Pi restart is an **unverified live check** (`scripts/reconnect-probe.ts`).

Grok's MCP client POSTs directly to the in-process HTTP server. Routes are registered before `session/new` or `session/load`. GET gets 405, unknown IDs get 404, anonymous `{}` gets 400 rather than an authentication challenge. In the default HTTP mode, no `x.ai/mcp/sdk` advertisement or `x.ai/mcp/servers` metadata is sent (`src/model/mcp-server.ts`, `test/transport.test.ts`).

HTTP is what we run. `PI_GROK_MCP=sdk` exists only for one Manager live probe; after that probe **exactly one of these two paths is deleted**. `readConfig` reads this environment-only switch once (`http` by default, `sdk` allowed, any other value throws); `model.ts` passes it to the connection. SDK mode advertises initialize `_meta: { "x.ai/mcp/sdk": true }`, registers `_meta["x.ai/mcp/servers"]: [{ name, serverId }]` on session/new and session/load, and opens no HTTP server. Both modes retain `mcpConfig` tool timeouts. The always-registered `_x.ai/mcp/sdk_call` ACP handler dispatches to the same session `onMcp` and wraps its result or -32603 error (`src/model/connection.ts`, `test/transport.test.ts`).

Why the former shared leader could not route the SDK channel: the connection could not identify which client owned an in-process MCP server. MCP-over-ACP is half-duplex: initialize `x.ai/mcp/sdk`, session/new `x.ai/mcp/servers`, then agent-to-client `x.ai/mcp/sdk_call`. Source analysis: `~/.pi/agent/parallelized/results/20261004-192859-ksys7a.md`, consistent with Grok's user guide. This is harness analysis, **not a new live result**.

The guard watches reverse requests before the ACP SDK receives them. Orderly `close()` or `drop()` writes one fail-closed answer to child stdin, then ends the child; later handler answers are dropped. Legacy `guard` settings remain validated by `resolveGuard` but ack tiers are not applied. **A hung-but-alive Pi is unguarded**: Grok fails open when its hook times out. A timer in the same hung event loop would not run. Stdio close/process death covers Pi gone only because this child **is the agent**, not a bridge to an independently running leader. The same harness analysis (`~/.pi/agent/parallelized/results/20261004-192859-ksys7a.md`) distinguishes deployment lifetimes: stdio ACP has pipe lifetime; a leader is long-lived until update or shutdown; WebSocket serve can outlive a client reconnect. Pipe lifetime explains why a dead Pi stops its agent and why a hung-but-alive Pi is still unguarded.

Manager's 2026-10-04 probe reported that killing a shared-leader client left a tool running at the 10-second hook timeout, whereas killing the `--no-leader` agent mid-hook left no tool execution or Grok process. Reported versions: Grok 1.0.46, Pi 1.0.2, Node 26.10.0; source evidence: `evidence/client-gone-probe-kill*.json`. Those files are not present in this checkout, so the report is **unverified here**, not a new live result from this implementation. End-to-end stdio-direct live probes remain pending with the Manager.

## Permission prompts

Grok sends `session/request_permission` for some native calls, for example a shell redirect that writes a file.
Interactive Pi shows the dialog, unless `/grok perms` is `yolo`, which selects allow once. Headless Pi answers by `headlessPermissions` (`dialog`, `deny`, `reads`, `allow`). The default `dialog` cancels without a UI. `yolo` selects allow once without a UI as well.
`grokMode` (`default`, `auto`, `yolo`) goes to Grok as `_meta.autoMode` or `_meta.yoloMode` on `session/new` and `session/load`. Grok decides which prompts it sends in each mode. `/grok perms yolo` does not change `grokMode`. When a prompt still arrives, Pi selects allow once (`permissionAnswer` in `src/model/permissions.ts`).

## Steering

Pi's `input` event gives `streamingBehavior`: `undefined` when idle, `steer` for Enter during a turn, `followUp` for Alt+Enter. The steer handler takes only the `steer` case when a Grok session exists. It sends the text to `_x.ai/interject`, records a `grok-steer` entry, and returns `{ action: "handled" }`, so the text does not enter Pi's queue. Slash commands and empty input pass through. If the interject request fails, Pi queues the text normally and shows a notice.

Unit tests cover this with a mocked Grok (`test/steer.test.ts`). The live effect of an interjection on the running Grok turn has no saved evidence in this repository. See the development record below.

The registered `input` handler acts only while the active model's provider is `grok`. After a switch to another model in the same Pi session, mid-turn Enter goes to that model; the stored Grok session is used again on a switch back. `test/extension.test.ts` drives the registered handler across Grok, another provider, no model, and Grok again. An earlier version checked only for a stored Grok session ID and would have taken the steer after the switch.

## Development record

Historical WebSocket-gateway runs are recorded in [launch-verification.md](launch-verification.md). They are not evidence for stdio-direct. Obsolete gateway probe scripts exit 2; `scripts/model-probe.ts` and `scripts/reconnect-probe.ts` are adapted, but have not been run for this implementation.

## Open items

- Steering: verify the live effect of an interjection on the running turn.
- Pi skills under the Grok model: Pi expands `/skill:x` into the user message, and Grok receives it as plain text. Grok lists the skills in the shared `.agents/skills` directories itself. Pi's catalog entry (name, description, and `SKILL.md` path) for each skill outside them, such as one a Pi package ships, goes to Grok in the rules, and Grok reads a skill file with its own file tool. Grok must translate Pi tool names such as `edit` and `bash` to its own tools. Not yet checked live. Earlier live checks ran with `--no-skills`.
- Media: probe `image_edit` and the video result types. Video shows as a path only.
- Session history: verify `session/load` across new `--no-leader` children with the restart probe.
- Tasks: Grok's task tools (`spawn_subagent`, `monitor`, and others) are model tools only. A `/grok tasks` command needs a listing method from Grok.
- Pi stream hooks: call `options.onPayload` and `options.onResponse`, as Pi's custom provider guide asks.

## Limits

- When the prompt response carries no usage report, usage and cost are zero.
- The offered Pi tool list is read once for each Grok session.
- Pi's transcript holds Grok tool activity as `grok-tool` custom entries, not as structured tool calls.
- Pi compaction does not change Grok's history. `/grok compact` compacts Grok's history.
