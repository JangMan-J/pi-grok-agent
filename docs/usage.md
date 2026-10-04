# pi-grok-agent reference

This page is the reference for settings, commands, and operation. Start with the [README](../README.md) for the install command and requirements. Design notes are in [first-class-model.md](first-class-model.md).

## Contents

- [Components](#components)
- [Install options](#install-options)
- [Models and Pi controls](#models-and-pi-controls)
- [Slash command /grok](#slash-command-grok)
- [Grok permission prompts](#grok-permission-prompts)
- [Lent Pi tools](#lent-pi-tools)
- [Hooks around Grok tools](#hooks-around-grok-tools)
- [Close-time guard](#close-time-guard)
- [Generated media and attached images](#generated-media-and-attached-images)
- [Settings](#settings)
- [Environment variables](#environment-variables)
- [Session lifecycle](#session-lifecycle)
- [Files and network](#files-and-network)
- [Stdio log](#stdio-log)
- [Isolation](#isolation)
- [Checks](#checks)
- [Live probes](#live-probes)
- [Troubleshooting](#troubleshooting)

## Components

| Component | Source | Function |
| --- | --- | --- |
| Pi extension | `src/model.ts` | Registers provider `grok`, the `/grok` command, the steer handler, and the renderers for `grok-tool`, `grok-tools`, `grok-media`, `grok-steer`, and `grok-command`. |
| Tool rows | `src/tool-batch.ts` | Groups routine Grok tool calls into `grok-tools` rows. A failure, denial, media result, or post-edit note gets its own `grok-tool` row; it first writes the calls batched before it, so rows keep call order. |
| Stream adapter | `src/model/provider.ts` | Turns a Pi turn into an ACP `session/prompt` and turns ACP updates into Pi stream events. |
| Connection | `src/model/connection.ts` | One non-detached stdio agent child per Pi process. Creates or loads Grok sessions and routes reverse requests. |
| Session state | `src/model/session.ts` | Turn state, hook answers, lent tool calls, media copies, usage totals. |
| Hooks | `src/model/hooks.ts` | Tool classification, capability gate, post-edit check, stop check. |
| Permissions | `src/model/permissions.ts` | Pi dialogs and headless answers for Grok permission prompts. |
| Questions | `src/model/questions.ts` | Pi dialogs for Grok's `ask_user_question`. |
| Steering | `src/model/steer.ts` | Sends mid-turn Enter to Grok's `_x.ai/interject`. |
| Lent tool policy | `src/tool-policy.ts`, `src/model/extensions-command.ts` | Selects the Pi tools lent to Grok, names them for MCP, and runs `/grok extensions`. |
| Login | `src/login.ts` | Runs `grok login --device-auth` for `/grok login`. |
| Settings | `src/config.ts` | Reads `grok-ws.json` and environment overrides. Validates legacy guard settings without applying timers. |

## Install options

Install with `pi install npm:pi-grok-agent`. For this prototype checkout, run `npm install`, then `pi -e . --model grok/grok-4.7`. Pi loads the TypeScript extension using its own loader.

The first Grok turn starts `grok --permission-mode default agent --no-leader stdio`; extension loading alone starts nothing. No daemon, shared leader, fixed port, or bearer secret is required. `src/model/connection.ts` owns only this child, ending it on connection close. Node >=22.19 and Grok on PATH (or `PI_GROK_BINARY`) are required. Grok uses its own stored login, not an xAI API key.

## Models and Pi controls

| Model ID | Name | Pi thinking levels mapped to Grok reasoning effort |
| --- | --- | --- |
| `grok/grok-4.7` | Grok 4.7 | low, medium, high, xhigh |
| `grok/grok-4.7-build-fast` | Grok 4.7 Build Fast | low, medium, high, xhigh |
| `grok/grok-4.6` | Grok 4.6 | low, medium, high, xhigh |
| `grok/grok-4.5` | Grok 4.5 | low, medium, high |

Which of these a Grok account may use depends on the account. Grok reports the allowed models for each session; a free account on 2026-09-28 had only `grok-4.7`. Pi switches the Grok session to the model picked in `/models`. A model the account lacks fails the turn with the list of available models; before 0.1.1, Grok silently ran its default model instead.

Each model's context window in Pi's metadata comes from Grok Build's model cache for the signed-in account (`~/.grok/models_cache.json`, `context_window`), read when the extension loads. ACP does not report it. Without the cache it is 256,000 tokens, the value Grok Build reported for every model on 2026-09-30. `/grok debug` shows the session's context use against the same number. The output limit in Pi's metadata is 32,000 tokens. Per-token cost is zero in the metadata. The turn cost comes from Grok's `turn_completed` report, converted at 1e9 ticks per US dollar. That ratio is inferred from Grok's rates. It is not documented by Grok.

Pi controls work as usual:

| Pi control | Effect on Grok |
| --- | --- |
| Thinking level (Shift+Tab or `/thinking`) | Sets Grok's `reasoning_effort` session option when the level changes. |
| Escape | Sends `session/cancel`. The next message starts a new Grok prompt. |
| Enter during a Grok turn | Sends the text to `_x.ai/interject` and records a `grok-steer` entry. The text does not enter Pi's queue. Slash commands are not steered. Grok accepts the request, but its effect on the running turn is not verified live. A `grok-steer` entry is not proof that Grok used the text. |
| Alt+Enter during a Grok turn | Queues a Pi follow-up. It becomes the next Grok prompt. |
| `/new` | New Pi session and new Grok session. |
| `/compact` | Compacts Pi's transcript only. Use `/grok compact` for Grok's history. |

Other Pi extensions that select a model by ID can use the same IDs, for example `grok/grok-4.7`.

The steer handler acts only while the active model is `grok/*`. After a switch to another model in the same Pi session, mid-turn Enter goes to that model. The stored Grok session is used again when you switch back (`test/extension.test.ts`).

## Slash command /grok

`/grok` covers Grok features that Pi has no control for. `/grok` without a subcommand does nothing. The completion menu shows the subcommands and their arguments.

| Command | Effect |
| --- | --- |
| `/grok debug` | Shows the stdio binary and connection state, the child pid and uptime, the last 3 exits (time, and exit code or signal), the last 10 stderr lines, pending Pi-to-Grok requests, MCP tools lent / calls served / calls failed, the stdio log path, the Grok session ID, Grok mode, Pi permission mode, Grok context size, usage and cost totals, blocked Pi extensions, and, after the first Grok turn in this Pi process, the lent tools and the tools the blocked extensions withhold, recent hook decision counts, and the number of Grok tool calls seen. |
| `/grok login` | Runs `grok login --device-auth` in the background and shows the URL and code as an entry and a notice. Grok may open the page itself, in your default browser. Approve it there; Pi reports when the login finished. Works before any Grok session exists. A signed-out child is dropped; the next turn initializes a fresh child. |
| `/grok perms` | Shows the Pi permission mode. |
| `/grok perms auto` | Default. Mirrors the Pi session's tools onto Grok's tools. |
| `/grok perms read-only` | Denies Grok's edit and shell tools, whatever tools the Pi session has. |
| `/grok perms ask` | Mirrors, then shows a Pi confirm dialog for each Grok edit or shell call. Without a UI it acts as `read-only`. |
| `/grok perms yolo` | Treats the Pi session as if it had `read`, `edit`, `write`, and `bash`, so the capability mirror allows Grok's edit and shell tools with no Pi confirm dialog. A Grok `session/request_permission` that still arrives is answered allow once, with no dialog. `denyGrokTools` still denies. `ask_user_question` still opens a dialog. For autonomous work in a workspace you can lose. |
| `/grok plan on`, `/grok plan off` | Sets Grok's session mode to `plan` or `default` with `session/set_mode`. |
| `/grok goal <objective>`, `goal status`, `goal pause`, `goal resume`, `goal clear` | Sends Grok's `/goal` command. This is a Grok turn outside Pi's model loop. |
| `/grok compact [note]` | Sends Grok's `/compact` on Grok's own history. This is a Grok turn. |
| `/grok extensions [list \| block <name> \| unblock <name>]` | Shows or edits the blocked Pi extensions. See [Lent Pi tools](#lent-pi-tools). |

`/grok goal` and `/grok compact` run through the same prompt lifetime as a normal turn. While one runs, the session is busy: a second command reports `Grok is busy with a turn`, and a normal message waits. A command times out after 10 minutes. The timeout cancels the prompt on Grok (`session/cancel`) and frees the session, and a late reply from the cancelled prompt is dropped.

The `perms` mode applies to Grok tool calls through the `pre_tool_use` hook, before Grok's own permission rules. A chosen mode persists as `permissionMode` in `grok-ws.json` and applies to every session from the next Pi load. It does not change `grokMode` or `headlessPermissions`.

## Grok permission prompts

Three separate settings affect Grok's tool calls:

| Setting | Where it acts | Values |
| --- | --- | --- |
| `/grok perms` | Pi's `pre_tool_use` hook, before Grok runs the tool | `auto` (default), `read-only`, `ask`, `yolo` |
| `grokMode` | Grok's own permission mode, sent with `session/new` and `session/load` | `default` (default), `auto` (sets Grok's `autoMode`), `yolo` (sets Grok's `yoloMode`) |
| `headlessPermissions` | Pi's answer to a Grok permission prompt when Pi has no UI | `dialog` (default), `deny`, `reads`, `allow` |

A call must pass Pi's hook first. `denyGrokTools` wins in every mode. `/grok perms yolo` answers a permission prompt that still arrives by selecting allow once, and does not open a dialog. The other `/grok perms` modes leave the prompt to the dialog or to `headlessPermissions`. `grokMode` decides which prompts Grok sends. Grok, not this package, defines what `auto` and `yolo` skip.

Grok asks for permission for some native tool calls, for example a shell command that writes a file with a redirect. Interactive Pi shows a selection dialog with Grok's options, unless `/grok perms` is `yolo`, which selects allow once. If you dismiss the dialog, Grok gets `cancelled` and ends the turn.

Headless Pi (`pi -p`, RPC, or another agent process without a UI) uses `headlessPermissions`:

| Value | Headless answer |
| --- | --- |
| `dialog` (default) | Cancel the prompt. Grok reports the tool as cancelled and ends the turn. |
| `deny` | Reject once. |
| `reads` | Allow once for prompts of kind read, search, fetch, or think. Reject the rest. |
| `allow` | Allow once. |

While `/grok perms` is `yolo`, Pi selects allow once and does not use this table. A rejected or cancelled prompt ends the Grok turn. Pi records a completed message, not an abort. Pi records an abort only when Pi itself cancelled the turn.

When Grok calls `ask_user_question`, Pi shows one dialog for each question. The dialog has Grok's options and `Other` for free text. In plan mode it also has `Chat about this` and `Skip interview`. Headless Pi answers `cancelled`.

## Lent Pi tools

Pi can offer its own tools to Grok in addition to Grok's tools. `piTools` in `grok-ws.json`, or `PI_GROK_PI_TOOLS`, selects them:

| Value | Tools offered to Grok |
| --- | --- |
| `extensions` (default) | Pi tools other than the core set and the blocked extension/tool surfaces below |
| `none` | No Pi tools |
| `all` | Every Pi tool (ignores blocked Pi extensions) |
| `a,b,c` | The named tools (ignores blocked Pi extensions) |

The core set Grok already has natively is always withheld under `extensions`: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`.

### Blocked extension/tool surfaces

Some Pi extensions duplicate or disrupt Grok native harness behavior, so Grok would route work through the MCP loopback instead of using its own tools. Under `extensions`, blocked extensions or tool surfaces are withheld on top of the core set. Package defaults (`DEFAULT_BLOCKED_PI_EXTENSIONS` in `src/tool-policy.ts`) are:

- `pi-lens`: code-navigation tools such as `symbol_search`, `project_report`, `module_report`, `read_symbol`, `read_enclosing`, `lens_diagnostics`, and related lazy tools overlap Grok's native `read_file`, `grep`, `list_dir`, and LSP.
- `codemode`: a meta-tool that can call other Pi tools and would bypass the curated lent-tool surface.
- `image-generation`: `generate_image`, which overlaps Grok's native image and video tools.

`all` and a named allow-list ignore blocked extensions.

Edit blocked Pi extensions with `/grok extensions`:

| Command | Effect |
| --- | --- |
| `/grok extensions` or `/grok extensions list` | Show blocked Pi extensions: package defaults plus your additions and removed defaults. |
| `/grok extensions block <name>` | Withhold all known tools from that Pi extension under `extensions`. |
| `/grok extensions unblock <name>` | Lend a blocked extension's tools to Grok again under `extensions` (including a package default). |

Edits persist to `blockedPiExtensions` in `grok-ws.json` and take effect on the next Grok session (Grok reads the tool list once per session). A `blockedPiExtensions` list in the file is authoritative: it replaces the package defaults, so `/grok extensions unblock` can drop a default and it stays dropped. Runtime tool metadata from Pi is used when available, so `/grok extensions block <name>` can block a source or namespace even when this package has no static registry for it.

Grok's model calls a lent tool through `use_tool` with the name `pi__<name>`. Grok skips an MCP tool whose `server__tool` key has more than one `__`, contains `___`, or has a tool name with a character other than an ASCII letter, a digit, `_`, or `-` (the MCP catalog rules in the documentation bundled with Grok Build 1.0.46). Pi names that obey those rules are used as is. In other names, each other character becomes `_`, runs of `_` become one `_`, and leading and trailing `_` are removed; a clash gets a `_2` suffix (`createPiToolRoutes` in `src/tool-policy.ts`). Pi's `mcp__docs__search` is `pi__mcp_docs_search`, and the rules give its Pi name next to it. Grok does not show MCP tool names to its model, so the rules Pi sends to Grok list each lent tool by its `pi__` name (`grokRulesFromPiPrompt` in `src/model/provider.ts`). `/grok debug` shows the same names.

The Pi assistant message uses the Pi tool name. Pi executes the tool through its own loop and permission gates, and the same Grok turn continues with the result. Pi passes the complete tool result to Grok.

Lent tools go over Grok's MCP-over-ACP channel on the same stdio pipe. `initialize` sends `_meta['x.ai/mcp/sdk']: true`. `session/new` and `session/load` send `_meta['x.ai/mcp/servers']` with the server name and id. Grok then sends each MCP JSON-RPC message as `_x.ai/mcp/sdk_call`, and `session.ts` `onMcp` answers it (`src/model/connection.ts`, `test/transport.test.ts`). Live check 2026-10-04: tools/list, `pi_echo_secret`, a 5 s held wait, and the token came back (`docs/launch-verification.md`).

Grok reads the tool list once for each Grok session. If Grok has an equivalent native tool, it usually uses its own tool.

## Hooks around Grok tools

The provider registers Grok client hooks in every Grok session it creates. Grok still executes each tool. Pi decides and adds context around it.

| Hook | What Pi does |
| --- | --- |
| `pre_tool_use` | Applies the `/grok perms` mode and the capability mirror. A Pi session without `edit` or `write` denies Grok's edit tools. A session without `bash` denies Grok's shell. The deny reason goes to Grok. |
| `post_tool_use` | After a Grok edit, runs a syntax check on the file or the configured `postEditCheck`. A failure goes to Grok as additional context in the same turn. Records a `grok-tool` entry and copies media. |
| `post_tool_use_failure` | Records a failed `grok-tool` entry. |
| `stop` | Runs the configured `stopCheck` at the end of a turn. A non-zero exit blocks the end of the turn and gives Grok the output. Grok limits the number of continuations. |

Classification uses Grok's `x.ai/tool` stamp (kind and `read_only`) on each tool call. A table of tool names is the fallback. In a read-only Pi session, a stamped tool that Grok marks as mutating is denied when the table does not know it.

MCP and plugin tools arrive as `server__tool` through Grok's `use_tool` dispatcher. In a read-only Pi session they are denied, unless the tool's `_meta` has `readOnlyHint: true` or the server is in `mcpReadOnlyServers`. Grok 1.0.41 does not forward MCP `annotations`, so a server must put `readOnlyHint` in `_meta`. Lent Pi read tools do this.

Built-in post-edit checks:

| File | Check |
| --- | --- |
| `.ts`, `.mts`, `.cts` | Node type stripping, then a module parse. The code does not run. |
| `.js`, `.mjs`, `.cjs` | `node --check` |
| `.py` | `python3 -m py_compile` |
| `.json` | `JSON.parse` |
| `.rs` | `rustfmt --check --edition 2021` |

Precedence: `denyGrokTools`, then `allowGrokTools`, then the capability mirror, where a tool's `_meta` read-only marker and `mcpReadOnlyServers` apply to MCP tools. `/grok perms` changes the capabilities that the mirror uses, so `denyGrokTools` wins in every mode. In `ask` mode, an allowed edit or shell call then gets a Pi confirm dialog. Hook errors fail open, as Grok's own hooks do.

Each completed Grok tool call becomes a consolidated session entry with the tool, input, status, output (up to 8000 characters), and duration. Routine completions batch into one `grok-tools` row per 10 calls (`N calls (2 read_file · 1 grep)` plus total ms; leftovers flush at turn end). Failures, denials, media captures, and post-edit notes keep their own `grok-tool` rows. The expanded batch view shows each call with up to 200 characters of output; the expanded single view shows up to 600. Turn usage is not a separate entry: the provider puts it on the assistant message in Pi's convention (`input` excludes cached reads; `cacheRead` separate), where Pi and zentui's Turn summary and footer cache figure already show it. Setup, MCP readiness, model switches, and intermediate tool phases are silent. No model receives these entries.

## Close-time guard

`src/model/guard.ts` tracks one lifetime for each reverse hook, permission prompt, or question. On orderly close it denies `pre_tool_use`, continues `post_tool_use` and `stop`, rejects permissions (prefer `reject_once`), and cancels questions. Late answers are suppressed. Slow dialogs get the handler's answer, not a timer denial (`test/transport.test.ts`).

No ack tiers or timers are applied. Legacy `guard` values remain validated for config compatibility (`test/guard.test.ts`). **A hung-but-alive Pi is unguarded: Grok fails open at the hook timeout.** Stdio close covers Pi gone because the child is the agent itself. See [Failure modes](first-class-model.md#failure-modes).

## Generated media and attached images

| Direction | Behavior |
| --- | --- |
| Grok to Pi | Tool results of type `ImageGen`, `ImageEdit`, `ImageToVideo`, `ReferenceToVideo`, or `VideoGen` are copied to `mediaDir` (default `.pi/grok-images/` under the Pi working directory, with a `.gitignore` that ignores all files). The `grok-tool` entry shows `saved <path>`. After the turn, a `grok-media` message shows the path and, for PNG, JPEG, WebP, and GIF, the image inline where the terminal supports images. |
| Pi to Grok | Attached images are written to `pi-grok-images/` in the system temp directory with mode 0600. The prompt refers to the file path. Grok reads the file with its own tools. |

PNG shows directly. JPEG, WebP, and GIF are converted to PNG with `magick` for display and cached in the temp directory. Without `magick`, the message shows only the path for those formats. Video shows as a path only. Set `mediaDir` to an empty string to keep only Grok's original path.

The `grok-media` message is for display only. The provider removes it from the prompt, so Grok does not receive its own image back.

Historical development runs probed `image_gen` only; its gateway probe is now disabled. Image edit and the video types are recognized by name in code and are not yet probed.

## Settings

Optional settings file: `~/.pi/agent/grok-ws.json`. If `PI_CODING_AGENT_DIR` is set, the file is in that directory.

```json
{
  "piTools": "extensions",
  "blockedPiExtensions": ["pi-lens", "codemode", "image-generation"],
  "headlessPermissions": "dialog",
  "mediaDir": ".pi/grok-images",
  "grokMode": "default",
  "hooks": {
    "denyGrokTools": [],
    "allowGrokTools": [],
    "mcpReadOnlyServers": [],
    "postEditCheck": "",
    "stopCheck": ""
  },
  "guard": { "ackMs": 5000, "policyMs": 15000, "checkBudgetMs": 590000, "dialogMs": 600000 }
}
```

| Key | Meaning |
| --- | --- |
| `piTools` | `extensions` (default), `none`, `all`, or a comma/list of exact Pi tool names. See [Lent Pi tools](#lent-pi-tools). |
| `blockedPiExtensions` | Effective blocked extension/tool-surface list for `piTools: "extensions"`. If present, replaces the package defaults. |
| `permissionMode` | Pi-side permission mode set by `/grok perms`: `yolo`, `auto` (default), `ask`, or `readonly`. |
| `toolBatchSize` | Routine native tool completions summarized per `grok-tools` batch row. Positive integer, default 10. Leftovers flush at turn end, before tree navigation, and when the session ends. Read when Pi loads the extension: reload Pi after a change. |
| `grokMode` | Grok's own permission mode: `default`, `auto`, or `yolo`. Sent each time Pi attaches a Grok session. Separate from `/grok perms`. See [Grok permission prompts](#grok-permission-prompts). |
| `hooks.denyGrokTools`, `hooks.allowGrokTools` | Regular expressions that match the whole Grok tool name. |
| `hooks.mcpReadOnlyServers` | MCP server names whose tools count as read-only. |
| `hooks.postEditCheck` | Command after a Grok edit. `{file}` is the edited file. Replaces the built-in checks. |
| `hooks.stopCheck` | Command at the end of a turn. A non-zero exit holds the turn. |

Example with checks:

```json
{
  "hooks": {
    "denyGrokTools": ["web_search", "image_.*"],
    "postEditCheck": "npx tsc --noEmit -p .",
    "stopCheck": "npm test"
  }
}
```

## Environment variables

| Variable | Overrides or sets |
| --- | --- |
| `PI_CODING_AGENT_DIR` | Pi's agent directory, which holds `grok-ws.json` and Pi sessions |
| `PI_GROK_PI_TOOLS` | `piTools` |
| `PI_GROK_HEADLESS_PERMISSIONS` | `headlessPermissions` |
| `PI_GROK_MEDIA_DIR` | `mediaDir` |
| `PI_GROK_GROK_MODE` | `grokMode` |
| `PI_GROK_DENY_TOOLS` | `hooks.denyGrokTools`, comma-separated |
| `PI_GROK_POST_EDIT_CHECK` | `hooks.postEditCheck` |
| `PI_GROK_STOP_CHECK` | `hooks.stopCheck` |
| `PI_GROK_ACK_MS`, `PI_GROK_POLICY_MS`, `PI_GROK_CHECK_BUDGET_MS`, `PI_GROK_DIALOG_MS` | Legacy `guard` values: validated but no timers are armed |
| `PI_GROK_BINARY` | Grok executable, read at spawn time. Default `grok`. |

## Session lifecycle

- The first turn in a Pi session sends `session/new`. Pi stores the Grok session ID in a `grok-model-session` entry, outside model context.
- Ordinary later turns reuse the same connection and the attached Grok session. They send no `session/load`.
- `session/load` with the stored ID occurs only when Pi attaches a stored session that this connection has not attached yet: for example, when a new Pi process resumes the session, and after a reconnect.
- A Pi fork or tree navigation starts a new Grok session.
- Pi sends its system prompt as `_meta.rules` and only the new user messages or tool results as the prompt.
- If the child exits between turns, the next turn starts one fresh child and `session/load`s the stored id. Two turns that start together share that one child. A child that exits during a turn ends that turn with the exit code or signal and the last stderr lines. Send the message again.
- If `session/load` reports that the id is missing, Pi sends `session/new`, stores the new id, and shows `[grok session <id> not found; started a new one]` once.
- A stored id from another directory starts a new session. Grok keeps sessions under `~/.grok/sessions/<encoded-cwd>/` (`~/.grok/docs/user-guide/17-sessions.md`). Pi shows `[grok session <id> belongs to <old cwd>; started a new one]` once.
- Escape sends `session/cancel`. If the prompt does not settle within 5 seconds, Pi kills the child. The turn ends either way.
- A fresh `--no-leader` child loaded the stored Grok session after a Pi restart on 2026-10-04 (`docs/launch-verification.md`).
- After you change files under `src/model/`, start a new `pi` process. `/reload` can keep the provider module that Pi already imported.

## Files and network

Settings stay in `~/.pi/agent/grok-ws.json` or `PI_CODING_AGENT_DIR`. Pi session files hold the Grok session ID and display entries. Media copies stay in `.pi/grok-images/`; attached images use the system temporary directory (`src/model/session.ts`, `src/model/provider.ts`). Grok manages its own login and data under `~/.grok/`. Child stderr and skipped stdout frames are in the [stdio log](#stdio-log).

ACP uses pipes. Lent tools use the same pipe. Grok's external network use is managed by Grok itself (`src/model/connection.ts`).

## Stdio log

Child stderr and skipped stdout frames go to `<agent dir>/grok-stdio.log`. The agent dir is `PI_CODING_AGENT_DIR`, or `~/.pi/agent` when that variable is unset. Each line is `stderr: …`, `framing: skipped non-JSON stdout: …`, `exit: …`, or `spawn: …`.

The file rotates at 2 MB. When the next line would start past that size, the current file is renamed to `grok-stdio.log.1` and a new log starts. One line can push the live file past 2 MB before the next rotation. `/grok debug` prints the path and the last 10 stderr lines.

## Isolation

Use `PI_CODING_AGENT_DIR` for separate Pi settings/sessions and `PI_GROK_BINARY` to select the executable. Both are inherited at child spawn time. Each Pi owns its agent. There is no shared leader or leader socket. These variables do not isolate Grok's login or sandbox its tools.

## Checks

```sh
npm install          # includes TypeScript and type packages
npm run check        # tsc --noEmit
npm test             # node --test test/*.test.ts, no Grok calls
```

`test/transport.test.ts` starts real stdio children using `test/fixtures/fake-grok.ts`. It checks exact argv, child reuse/drop, signed-out retry, in-process MCP during attach, model selection, orphan hooks, slow dialogs, close-time answers, late suppression, failed attach routing, and startup failures. `test/hardening.test.ts` covers one failure mode per numbered case in [Failure modes](first-class-model.md#failure-modes). No real Grok is run.

The unit tests cover the turn split around a lent tool call, abort and resend, prompt tail selection, display-only messages, usage mapping, tool classification and gates, `/grok perms` modes, guard tier validation, question dialogs, steering with a mocked Grok, the steer handler across a model switch, `/grok` command timeout and completion through the shared prompt lifetime, media copies, the lent tool policy and names, `/grok extensions`, `/grok login` output parsing, and context windows from Grok's model cache.

## Live probes

Live probes spend Grok usage: run only when explicitly requested. `scripts/model-probe.ts` checks `_x.ai/mcp/sdk_call` for a Pi-held tool. `scripts/reconnect-probe.ts` restarts Pi and checks `session/load` of the stored Grok session. `npm run test:live` invokes those two probes. They write `evidence/model-probe.json` and `evidence/reconnect-probe.json`. Both passed on 2026-10-04 (`docs/launch-verification.md`).

`scripts/client-gone-probe.ts` spawns a Grok stdio client directly and kills it with a `pre_tool_use` hook unanswered. See [launch-verification.md](launch-verification.md#client-death-probe-2026-10-04).

`scripts/hooks-live.sh` remains an opt-in Pi-driven live check, not part of ordinary tests. Gateway-only probes exit 2 with `stdio-direct: this probe targeted the removed WebSocket gateway and was not rewritten.` They are not evidence for this branch. Historical [launch-verification.md](launch-verification.md) results describe the removed transport. Review local evidence for private paths, session IDs, and tokens before sharing it.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| The turn ends with `Grok child \`grok\` ended (exit code N)` or `(signal SIG…)`, often with `Last stderr:` | The child exited during the turn (crash, out of memory, `SIGKILL`, or Grok replacing its binary). | Send the message again. The next turn starts a new child and loads the stored Grok session. Parked lent-tool calls from that child are rejected. |
| The next message shows `[grok reconnected after: …; session … reloaded]` | The child exited while Pi was idle. | None. The next turn starts one child. Two turns that open together share that start. |
| `Cannot start Grok: \`…\` was not found` | `grok` is missing from `PATH`, or `PI_GROK_BINARY` names a missing file. The turn fails within 30 seconds. | Install Grok Build, or set `PI_GROK_BINARY` to the executable. |
| `Cannot start Grok: \`…\` is not executable` | The file at `PI_GROK_BINARY` cannot be executed. | Point `PI_GROK_BINARY` at a Grok Build binary you can run. |
| `does not provide \`agent --no-leader stdio\`` | The binary exited during startup with code 2 or a usage error. It is older than Grok Build 1.0.46, or it rejects `--no-leader`. Stderr is included in the message. | Install Grok Build 1.0.46 or newer, or set `PI_GROK_BINARY` to that executable. |
| `Grok Build is not signed in. Run /grok login, …` | `initialize` returned no `cached_token` method, or `authenticate` failed. | Run `/grok login` and approve the code, then send the message again. Pi's `/login` xAI entry signs in a different client. `XAI_API_KEY` does not replace Grok's stored login. |
| A `grok` process remains after Pi was killed with `SIGKILL` | Node cannot set a parent-death signal. Closing Pi's pipes is the only signal the child gets. The child exits when it stops on stdin EOF. | Kill the leftover process. A normal Pi exit, `SIGINT`, or `SIGTERM` closes stdin, then sends `SIGTERM`, then `SIGKILL`. |
| `grok-stdio.log` contains `framing: skipped non-JSON stdout` and the turn continues | The child wrote a warning, or a partial line, on stdout. A prefix glued to the next `{"jsonrpc"` frame is skipped and the frame is kept. | None. Child stderr is in the same log. It is kept off Pi's stdout. |
| A tool result of several megabytes pauses, then completes | `stdin.write` returned false because the pipe buffer was full. | None. The next write waits until the buffer drains. |
| `Grok did not answer <method> within Ns. The child was stopped.` | The child missed its deadline: `initialize` and `authenticate` 30 s, `session/new` and `session/load` 60 s, `session/set_mode` and `session/set_config_option` 10 s, other requests 30 s. `session/prompt` has no deadline. | Send the message again. The child was killed. The next turn starts a new child and loads the stored session. |
| Escape ends the turn, or the message is `Grok did not acknowledge session/cancel within 5s` | Pi sent `session/cancel`. The in-flight prompt did not settle within 5 seconds. | The turn ends either way. When the acknowledgement is missing, the child is killed. Send the message again. |
| A thinking line `[grok session <id> not found; started a new one]` | `session/load` failed because that id is not on disk (for example `~/.grok` was removed). | None. Pi starts a new session, stores the new id, and shows the note once. A timeout or a dropped pipe does not take this path. |
| A thinking line `[grok session <id> belongs to <cwd>; started a new one]` | The stored id was created in another directory. Grok stores each session under `~/.grok/sessions/<encoded-cwd>/<id>/`. | None. Pi starts a new session for this directory and shows the note once. |
| A tool is denied with `No Pi session owns this Grok session; the request was answered immediately.` | A hook, permission, or question arrived for a Grok session Pi no longer owns (`/new` or the session tree). | None. Pi answers deny or cancel immediately. |
| A hook is denied with `Malformed hook payload: …` | The payload omitted `hookEventName` or another required field, or the handler threw. | None. Pi denies that hook and returns the reason. |
| You need the child pid, uptime, recent exits, stderr, pending requests, or MCP counts | Those values are on the live connection. | Run `/grok debug`. |
| You need stderr or skipped frames older than the last 10 lines | `/grok debug` keeps a 10-line ring. | Open `<agent dir>/grok-stdio.log`. See [Stdio log](#stdio-log). |
| `Grok connection dropped mid-turn (…)` | The turn failed for a reason this package does not explain with its own message. | Send the message again. The next turn starts a new child and loads the stored session. Check the [stdio log](#stdio-log). |
| Pi does not know the model `grok/grok-4.7` | The extension did not load. | Use `pi -e <path-to-clone>` or `pi install <path-to-clone>`, and read the load error at startup. |
| `No Grok session yet. Send a message first.` | `/grok plan`, `goal`, and `compact` need a Grok session. | Send one prompt first. |
| Headless Pi ends the turn after a permission prompt | The default `headlessPermissions` is `dialog`, which cancels. | Set `deny`, `reads`, or `allow`. |
| No inline image | The terminal has no image support, or `magick` is missing for a JPEG, WebP, or GIF. | The path is still shown. Install `magick` to inline JPEG, WebP, and GIF. |
| No hashline tools | `~/.grok/config.toml` does not set `[toolset] file_toolset = "hashline"`. | This is expected until that setting is present. |
