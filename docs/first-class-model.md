# Grok Build as a Pi model: design

Version 0.2.0. This page describes the implemented design. For use and settings, see the [README](../README.md) and [usage.md](usage.md).

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
| Lent Pi tools | Optional | MCP-over-ACP on the stdio pipe: `x.ai/mcp/sdk`, `x.ai/mcp/servers`, `_x.ai/mcp/sdk_call`. | `src/model/connection.ts`, `src/model/session.ts` `onMcp`, `test/transport.test.ts` |
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
3. First call for a Pi session: `session/new`. Later calls on the same connection reuse the attached session with no request. `session/load` of the stored Grok session occurs only on attach to a connection that has not attached it yet, for example in a new Pi process or after a reconnect. Grok's session guide says clients can load a previous session by ID (`~/.grok/docs/user-guide/17-sessions.md`). A fresh `--no-leader` child did that on 2026-10-04 (`docs/launch-verification.md`).
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

## Direct agent and MCP-over-ACP

Grok Build 1.0.46's user guide documents `grok agent stdio` as the local ACP integration path for custom tools and ACP SDKs (`~/.grok/docs/user-guide/15-agent-mode.md`, section "stdio transport"). This package follows that path (`src/model/connection.ts`): one non-detached child, `grok --permission-mode default agent --no-leader stdio`. The guide's example passes `--always-approve`; this child does not. The child env sets `GROK_DISABLE_AUTOUPDATER=1`. The same release's headless guide says SDKs inject that for the non-leader agents they spawn (`~/.grok/docs/user-guide/14-headless-mode.md`). There is no leader supervision, lock file, or shared agent. `drop()` ends this child; the next `open()` starts another.

Lent tools use Grok's MCP-over-ACP channel on that pipe: `initialize` `_meta['x.ai/mcp/sdk']`, then `session/new` or `session/load` `_meta['x.ai/mcp/servers']`, then agent-to-client `_x.ai/mcp/sdk_call`. The call is one MCP JSON-RPC message, and `session.ts` `onMcp` answers it. A shared leader in Grok 1.0.41 could not route `sdk_call`: the channel is half-duplex and single-connection, so the leader cannot tell which client owns the in-process server. With one `--no-leader` agent per Pi, that client is the only one. Live 2026-10-04, Grok 1.0.46, Pi 1.0.2, Node 26.10, commit `7c26faa`: `scripts/model-probe.ts` listed tools, called `pi_echo_secret`, held 5 s, and returned the token with `end_turn` (`docs/launch-verification.md`).

A new Pi process resumes a stored Grok ID with `session/load`. Sessions are persisted on disk under `~/.grok` regardless of transport (the harness analysis calls this “notes in a filing cabinet”). The session guide says the agent persists session updates and that clients can reconnect and load previous sessions by ID (`~/.grok/docs/user-guide/17-sessions.md`). The same live run recalled a token through a fresh `--no-leader` child after Pi restarted, with the same Grok session id.

The guard watches reverse requests before the ACP SDK receives them. Orderly `close()` or `drop()` writes one fail-closed answer to child stdin, then ends the child; later handler answers are dropped. Legacy `guard` settings remain validated by `resolveGuard` but ack tiers are not applied. **A hung-but-alive Pi is unguarded**: Grok fails open when its hook times out. A timer in the same hung event loop would not run. Stdio close/process death covers Pi gone only because this child **is the agent**, not a bridge to an independently running leader. The same harness analysis (`~/.pi/agent/parallelized/results/20261004-192859-ksys7a.md`) distinguishes deployment lifetimes: stdio ACP has pipe lifetime; a leader is long-lived until update or shutdown; WebSocket serve can outlive a client reconnect. Pipe lifetime explains why a dead Pi stops its agent and why a hung-but-alive Pi is still unguarded.

The client-death probe on 2026-10-04 is recorded in [launch-verification.md](launch-verification.md#client-death-probe-2026-10-04). A shared leader ran the tool after the client was killed. The `--no-leader` agent did not, and no Grok process remained.

## Permission prompts

Grok sends `session/request_permission` for some native calls, for example a shell redirect that writes a file.
Interactive Pi shows the dialog, unless `/grok perms` is `yolo`, which selects allow once. Headless Pi answers by `headlessPermissions` (`dialog`, `deny`, `reads`, `allow`). The default `dialog` cancels without a UI. `yolo` selects allow once without a UI as well.
`grokMode` (`default`, `auto`, `yolo`) goes to Grok as `_meta.autoMode` or `_meta.yoloMode` on `session/new` and `session/load`. Grok decides which prompts it sends in each mode. `/grok perms yolo` does not change `grokMode`. When a prompt still arrives, Pi selects allow once (`permissionAnswer` in `src/model/permissions.ts`).

## Steering

Pi's `input` event gives `streamingBehavior`: `undefined` when idle, `steer` for Enter during a turn, `followUp` for Alt+Enter. The steer handler takes only the `steer` case when a Grok session exists. It sends the text to `_x.ai/interject`, records a `grok-steer` entry, and returns `{ action: "handled" }`, so the text does not enter Pi's queue. Slash commands and empty input pass through. If the interject request fails, Pi queues the text normally and shows a notice.

Unit tests cover this with a mocked Grok (`test/steer.test.ts`). The live effect of an interjection on the running Grok turn has no saved evidence in this repository. See the development record below.

The registered `input` handler acts only while the active model's provider is `grok`. After a switch to another model in the same Pi session, mid-turn Enter goes to that model; the stored Grok session is used again on a switch back. `test/extension.test.ts` drives the registered handler across Grok, another provider, no model, and Grok again. An earlier version checked only for a stored Grok session ID and would have taken the steer after the switch.

## Development record

Historical WebSocket-gateway runs are recorded in [launch-verification.md](launch-verification.md). They are not evidence for stdio-direct. The 2026-10-04 stdio probes on that page are. Obsolete gateway probe scripts exit 2.

## Open items

- Steering: verify the live effect of an interjection on the running turn.
- Pi skills under the Grok model: Pi expands `/skill:x` into the user message, and Grok receives it as plain text. Grok lists the skills in the shared `.agents/skills` directories itself. Pi's catalog entry (name, description, and `SKILL.md` path) for each skill outside them, such as one a Pi package ships, goes to Grok in the rules, and Grok reads a skill file with its own file tool. Grok must translate Pi tool names such as `edit` and `bash` to its own tools. Not yet checked live. Earlier live checks ran with `--no-skills`.
- Media: probe `image_edit` and the video result types. Video shows as a path only.
- Tasks: Grok's task tools (`spawn_subagent`, `monitor`, and others) are model tools only. A `/grok tasks` command needs a listing method from Grok.
- Pi stream hooks: call `options.onPayload` and `options.onResponse`, as Pi's custom provider guide asks.

## Failure modes

`test/hardening.test.ts` drives each case with `test/fixtures/fake-grok.ts`. No real Grok runs. The user-facing table is in [usage.md](usage.md#troubleshooting).

These recover with no user step:

- The child exits between turns. The next turn starts one child. Concurrent `open()` calls share one `opening` promise, so two turns cannot spawn two children. The stored id is loaded with `session/load`. When this Pi process had already attached, the stream shows `[grok reconnected after: …; session … reloaded]`.
- `session/load` says the id is missing. Pi sends `session/new`, stores the new id, and shows `[grok session <id> not found; started a new one]` once. A timeout or a closed pipe does not take this path.
- The stored id belongs to another directory. Grok stores sessions under `~/.grok/sessions/<encoded-cwd>/<id>/` (`~/.grok/docs/user-guide/17-sessions.md`). Pi starts a new session and shows `[grok session <id> belongs to <old cwd>; started a new one]` once.
- Stdout contains a non-JSON line, a partial line, or a warning glued onto the next `{"jsonrpc"` frame. The bad text is logged and skipped. The JSON-RPC frame is kept. Child stderr goes to the stdio log, never to Pi's stdout.
- A write fills the stdin buffer. The write waits for drain, then continues. A multi-megabyte tool result is delivered.
- A reverse request names a Grok session Pi does not own. Pi answers deny or cancel immediately.
- A hook payload is missing `hookEventName`, or the handler throws. Pi denies that hook with a reason.

These end the current turn. The next turn starts a new child and loads the stored id. Send the message again:

- The child exits during a turn. The error names the exit code or signal and the last stderr lines. Parked lent-tool calls reject.
- A Pi-to-Grok request misses its deadline. `initialize` and `authenticate` allow 30 seconds, `session/new` and `session/load` allow 60 seconds, `session/set_mode` and `session/set_config_option` allow 10 seconds, and other requests allow 30 seconds. `session/prompt` has no deadline and stays cancellable. The child is killed.
- Escape during a turn sends `session/cancel`. If the prompt does not settle within 5 seconds, the child is killed. The Pi turn ends either way.

These need a user action. The turn fails within the initialize deadline, and the message includes stderr when the child produced any:

- The binary is missing, or it is not executable. Install Grok Build, or set `PI_GROK_BINARY`.
- The binary has no `agent --no-leader stdio` (startup exit 2, or a usage error). Install Grok Build 1.0.46 or newer.
- Grok is signed out: `initialize` offers no `cached_token` method, or `authenticate` fails. Run `/grok login`.

Two residuals stay. A hung-but-alive Pi fails open at Grok's hook timeout. An ack timer in that same hung loop would not run. Node cannot set a parent-death signal. A normal Pi exit, `SIGINT`, or `SIGTERM` closes the child's stdin, then sends `SIGTERM`, then `SIGKILL`. `SIGKILL` of Pi only closes the pipes. The child then exits if it stops on stdin EOF. A child that ignores EOF can outlive that `SIGKILL`.

`/grok debug` shows the child pid, uptime, the last 3 exits, the last 10 stderr lines, the pending request count, and MCP tools lent, calls served, and calls failed. The full stderr and framing log is `<agent dir>/grok-stdio.log`, rotated at 2 MB to `grok-stdio.log.1`.

## Limits

- When the prompt response carries no usage report, usage and cost are zero.
- The offered Pi tool list is read once for each Grok session.
- Pi's transcript holds Grok tool activity as `grok-tool` custom entries, not as structured tool calls.
- Pi compaction does not change Grok's history. `/grok compact` compacts Grok's history.
