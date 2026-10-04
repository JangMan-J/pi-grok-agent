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
- [Gateway guard](#gateway-guard)
- [Generated media and attached images](#generated-media-and-attached-images)
- [Settings](#settings)
- [Environment variables](#environment-variables)
- [Session lifecycle](#session-lifecycle)
- [Files and network](#files-and-network)
- [Run a second, isolated gateway](#run-a-second-isolated-gateway)
- [Checks](#checks)
- [Live probes](#live-probes)
- [Troubleshooting](#troubleshooting)

## Components

| Component | Source | Function |
| --- | --- | --- |
| Pi extension | `src/model.ts` | Registers provider `grok`, the `/grok` command, the steer handler, and the renderers for `grok-tool`, `grok-tools`, `grok-media`, `grok-steer`, and `grok-command`. |
| Tool rows | `src/tool-batch.ts` | Groups routine Grok tool calls into `grok-tools` rows. A failure, denial, media result, or post-edit note gets its own `grok-tool` row; it first writes the calls batched before it, so rows keep call order. |
| Stream adapter | `src/model/provider.ts` | Turns a Pi turn into an ACP `session/prompt` and turns ACP updates into Pi stream events. |
| Connection | `src/model/connection.ts` | One WebSocket to the gateway. Creates or loads Grok sessions and routes reverse requests. |
| Session state | `src/model/session.ts` | Turn state, hook answers, lent tool calls, media copies, usage totals. |
| Hooks | `src/model/hooks.ts` | Tool classification, capability gate, post-edit check, stop check. |
| Permissions | `src/model/permissions.ts` | Pi dialogs and headless answers for Grok permission prompts. |
| Questions | `src/model/questions.ts` | Pi dialogs for Grok's `ask_user_question`. |
| Steering | `src/model/steer.ts` | Sends mid-turn Enter to Grok's `_x.ai/interject`. |
| Lent tool policy | `src/tool-policy.ts`, `src/model/extensions-command.ts` | Selects the Pi tools lent to Grok, names them for MCP, and runs `/grok extensions`. |
| Login | `src/login.ts` | Runs `grok login --device-auth` for `/grok login`. |
| Auto-start | `src/launch.ts` | Starts the bundled gateway when nothing listens on the endpoint. |
| Transport | `src/client.ts` | Validates the endpoint and carries JSON-RPC over the WebSocket. |
| Gateway | `scripts/server.ts` | Supervises one `grok agent leader`, bridges each WebSocket to a stdio leader client, relays lent-tool MCP calls, and guards reverse requests. |
| Settings | `src/config.ts` | Reads `grok-ws.json`, the secret, and environment overrides. Validates guard tiers. |

## Install options

The README uses one command: `pi install npm:pi-grok-agent`. The package contains the gateway. When a Grok turn finds nothing listening on a loopback `ws://` endpoint, the extension starts that gateway (see [Gateway auto-start](#gateway-auto-start)). The gateway runs compiled JavaScript from `dist/`, because Node does not strip TypeScript types under `node_modules`. The extension stays TypeScript: Pi loads it with its own loader.

To run the gateway yourself instead, for example under a service manager, install the command with `npm install -g pi-grok-agent` and run `pi-grok-gateway`. Pi does not put a package's `bin` on `PATH`, so this needs its own install. An extension that finds your gateway running does not start another one.

With a clone, `npm run server` and the extension (`pi -e .` or `pi install .`) come from the same checkout.

Pi does not install dependencies for a local path. It loads the directory in place. Run `npm install --omit=dev` in the clone before the first start. Pi runs the same `npm install --omit=dev` when it installs a git source.

A clone also auto-starts the gateway: it runs `scripts/server.ts` from the checkout. A git install (`pi install git:github.com/JangMan-J/pi-grok-agent`) takes the same path; its auto-start is not yet tested live. All install paths are recorded in [launch-verification.md](launch-verification.md).

### Gateway auto-start

- Trigger: a Grok turn opens the connection, and nothing accepts TCP on the configured loopback `ws://` endpoint. A `wss://` endpoint is never started.
- Process: the gateway of the installed version runs as a detached process with its own session, working directory `~`, and Pi's environment. It writes to `<agent dir>/grok-ws.log`. The first turn waits until the port accepts connections, about 5 seconds with a cold leader.
- Lifetime: the gateway keeps running after Pi exits. Every Pi process on the machine shares it. Stop it with `pkill -INT -f 'pi-grok-agent/(dist/)?scripts/server'`; it stops its leader.
- Two Pi processes that start at the same time are safe. The gateway binds its port before it starts or adopts a leader, so the second one exits with `EADDRINUSE` and both connect to the first.
- `/grok debug` shows `auto-start on` or `off`, and the pid when this Pi process started the gateway.
- Turn it off with `"autoStartGateway": false` in `grok-ws.json` or `PI_GROK_AUTOSTART=0`. Then start the gateway yourself before the first Grok turn.

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
| `/grok debug` | Shows the gateway URL and connection state, the Grok session ID, Grok mode, Pi permission mode, Grok context size, usage and cost totals, lent tools, blocked Pi extensions and the tools they withhold, recent hook decision counts, and the number of Grok tool calls seen. |
| `/grok login` | Runs `grok login --device-auth` in the background and shows the URL and code as an entry and a notice. Grok may open the page itself, in your default browser. Approve it there; Pi reports when the login finished. Works before any Grok session exists. A running gateway picks up the new login on the next turn, without a restart. |
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

The gateway serves the lent tools as an HTTP MCP server at `http://127.0.0.1:2419/mcp/<token>`. It relays each MCP message to the Pi connection that registered the token. Grok connects to that server with its own MCP client, so the stock `grok` binary works.

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

## Gateway guard

When a Grok client hook times out, Grok continues as if the hook allowed the call. Grok waits with no limit for a permission prompt. So the gateway answers for Pi when Pi cannot answer:

| Tier | Condition | Answer |
| --- | --- | --- |
| 0 | Pi answers | Pi's answer |
| 1 | Pi sent `pi/gate-ack` with `dialog: true` | Wait `dialogMs`, then reject |
| 1 | Pi sent `pi/gate-ack` with `check: true` | Wait `checkBudgetMs`, then continue |
| 1 | Pi sent `pi/gate-ack` without flags | Wait `policyMs`, then deny or reject |
| 2 | No ack in `ackMs`, or the Pi socket closed | Deny (`pre_tool_use`), continue (`post_tool_use`, `stop`), reject (permission), cancel (question) |

Each request has one guarded lifetime on the gateway. Pi's answer settles it and is forwarded. Once the gateway has answered for Pi, a later answer from Pi is dropped, so Grok gets exactly one response per request. When `/grok perms ask` opens a confirm dialog for a `pre_tool_use` hook, Pi sends a second ack with `dialog: true`, and the request moves from the policy deadline to the dialog deadline. `test/gateway.test.ts` checks these paths on the real wire with a fake Grok binary.

Defaults: `ackMs` 5000, `policyMs` 15000, `checkBudgetMs` 590000, `dialogMs` 600000. The settings loader refuses `ackMs` or `policyMs` at or above 30000 (the `pre_tool_use` hook timeout that this package registers), `checkBudgetMs` at or above 600000 (Grok's hook limit), and `ackMs` above `policyMs`.

## Generated media and attached images

| Direction | Behavior |
| --- | --- |
| Grok to Pi | Tool results of type `ImageGen`, `ImageEdit`, `ImageToVideo`, `ReferenceToVideo`, or `VideoGen` are copied to `mediaDir` (default `.pi/grok-images/` under the Pi working directory, with a `.gitignore` that ignores all files). The `grok-tool` entry shows `saved <path>`. After the turn, a `grok-media` message shows the path and, for PNG, JPEG, WebP, and GIF, the image inline where the terminal supports images. |
| Pi to Grok | Attached images are written to `pi-grok-images/` in the system temp directory with mode 0600. The prompt refers to the file path. Grok reads the file with its own tools. |

PNG shows directly. JPEG, WebP, and GIF are converted to PNG with `magick` for display and cached in the temp directory. Without `magick`, the message shows only the path for those formats. Video shows as a path only. Set `mediaDir` to an empty string to keep only Grok's original path.

The `grok-media` message is for display only. The provider removes it from the prompt, so Grok does not receive its own image back.

Development runs probed `image_gen` only. `scripts/image-probe.ts` repeats that check. Image edit and the video types are recognized by name in code and are not yet probed.

## Settings

Optional settings file: `~/.pi/agent/grok-ws.json`. If `PI_CODING_AGENT_DIR` is set, the file is in that directory.

```json
{
  "url": "ws://127.0.0.1:2419/ws",
  "secretFile": "~/.pi/agent/grok-ws.secret",
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
| `url` | Gateway WebSocket URL. A non-loopback URL must use `wss://`. The gateway itself accepts only a loopback `ws://` URL that ends in `/ws`. |
| `secretFile` | Absolute path or a path that starts with `~/`. |
| `autoStartGateway` | `true` (default) or `false`. See [Gateway auto-start](#gateway-auto-start). |
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
| `GROK_ACP_URL` | `url` |
| `GROK_AGENT_SECRET` | The secret. The gateway then does not create a secret file. |
| `PI_CODING_AGENT_DIR` | Pi's agent directory, which holds `grok-ws.json` and the secret |
| `PI_GROK_PI_TOOLS` | `piTools` |
| `PI_GROK_HEADLESS_PERMISSIONS` | `headlessPermissions` |
| `PI_GROK_MEDIA_DIR` | `mediaDir` |
| `PI_GROK_GROK_MODE` | `grokMode` |
| `PI_GROK_AUTOSTART` | `autoStartGateway`. `0`, `false`, `no`, or `off` turn it off. |
| `PI_GROK_DENY_TOOLS` | `hooks.denyGrokTools`, comma-separated |
| `PI_GROK_POST_EDIT_CHECK` | `hooks.postEditCheck` |
| `PI_GROK_STOP_CHECK` | `hooks.stopCheck` |
| `PI_GROK_ACK_MS`, `PI_GROK_POLICY_MS`, `PI_GROK_CHECK_BUDGET_MS`, `PI_GROK_DIALOG_MS` | `guard` values |
| `PI_GROK_LEADER_SOCKET` | Gateway only. Leader socket path. Default `~/.grok/pi/leader.sock`. |
| `PI_GROK_BINARY` | Gateway only. Grok executable. Default `grok`. |

## Session lifecycle

- The first turn in a Pi session sends `session/new`. Pi stores the Grok session ID in a `grok-model-session` entry, outside model context.
- Ordinary later turns reuse the same connection and the attached Grok session. They send no `session/load`.
- `session/load` with the stored ID occurs only when Pi attaches a stored session that this connection has not attached yet: for example, when a new Pi process resumes the session, and after a reconnect.
- A Pi fork or tree navigation starts a new Grok session.
- Pi sends its system prompt as `_meta.rules` and only the new user messages or tool results as the prompt.
- If the gateway restarts during a session, the next turn reconnects and loads the same Grok session. The turn in progress at the drop is lost.
- The gateway supervises the leader. If the leader exits, the gateway closes the bridges and starts a new leader or adopts one that a bridge started.
- After you change files under `src/model/`, start a new `pi` process. `/reload` can keep the provider module that Pi already imported.

## Files and network

| Item | Created by | Content |
| --- | --- | --- |
| `~/.pi/agent/` | Gateway | Directory, mode 0700, if missing |
| `~/.pi/agent/grok-ws.secret` | Gateway, first start | Random bearer secret, mode 0600 |
| `~/.pi/agent/grok-ws.json` | You | Optional settings |
| `~/.pi/agent/grok-ws.log` | Auto-started gateway | Gateway output, appended, mode 0600 |
| `~/.grok/pi/leader.sock` and `leader.lock` | Grok leader | Leader socket. It is outside Grok's `leader-*.sock` discovery pattern, so the Grok TUI does not attach to it. |
| `.pi/grok-images/` in the Pi working directory | Extension | Copies of Grok media, with a `.gitignore` |
| `pi-grok-images/` in the system temp directory | Extension | Attached images for Grok and PNG copies for display |
| Pi session file | Pi | `grok-model-session`, `grok-tool`, `grok-steer`, and `grok-command` entries |
| Grok session data | Grok | Stored by Grok under `~/.grok/` |

| Connection | Direction | Authentication |
| --- | --- | --- |
| `ws://127.0.0.1:2419/ws` | Pi to gateway | `Authorization: Bearer <secret>` header |
| `http://127.0.0.1:2419/mcp/<token>` | Grok to gateway | Token in the path. Unknown tokens get 404. |
| Leader socket | Gateway bridges to Grok leader | Local Unix socket |
| Grok's own network use | Grok | Managed by Grok Build, not by this package |

## Run a second, isolated gateway

Use this for a demo or a test next to a gateway that is in use. A second gateway with the default settings exits with `EADDRINUSE` before it touches any leader, so the running gateway is unaffected. It still needs its own port, leader socket, and agent directory to run.

Set the same variables in the gateway terminal and in the Pi terminal:

```sh
export PI_CODING_AGENT_DIR="$HOME/.pi-grok-isolated/agent"
export GROK_ACP_URL=ws://127.0.0.1:2429/ws
export PI_GROK_LEADER_SOCKET="$HOME/.grok/pi/isolated-leader.sock"
```

Then run `npm run server` in the clone, and in the other terminal run `pi -e <path-to-clone> --model grok/grok-4.7`. The gateway creates the leader directory `~/.grok/pi/` only, so keep the socket in that directory. `PI_CODING_AGENT_DIR` also gives Pi a separate agent directory with its own settings and sessions.

To clean up, press Ctrl+C in the gateway terminal. This stops its bridges and its leader. Then remove `~/.pi-grok-isolated`.

Do not run `scripts/reconnect-probe.ts` for isolated validation. These variables do not isolate it. See [Live probes](#live-probes).

## Checks

```sh
npm install          # includes TypeScript and type packages
npm run check        # tsc --noEmit
npm test             # node --test test/*.test.ts, no Grok calls
```

`test/gateway.test.ts` runs the real `scripts/server.ts` with `test/fixtures/fake-grok.ts` as the Grok binary (`PI_GROK_BINARY`) in a scratch `HOME`. It covers a launch that loses its port, leader ownership through shutdown, the guard tiers, the one-answer rule, disconnect, `ask` mode's dialog deadline, a turn that outlives its Pi session, a missing secret file, gateway auto-start, a signed-out Grok, and the model switch.

The unit tests cover the turn split around a lent tool call, abort and resend, prompt tail selection, display-only messages, usage mapping, tool classification and gates, `/grok perms` modes, guard tier validation, question dialogs, steering with a mocked Grok, the steer handler across a model switch, `/grok` command timeout and completion through the shared prompt lifetime, media copies, the lent tool policy and names, `/grok extensions`, `/grok login` output parsing, and context windows from Grok's model cache.

## Live probes

The probe scripts in `scripts/` run against a running gateway and your Grok login. They cost Grok usage. Several of them allow Grok's permission prompts inside temporary directories. The scripts with a file in the `Writes` column below write JSON results to `evidence/` in the repository root. Git ignores that directory; the only tracked file in it is the demo video. Create it first:

```sh
mkdir -p evidence
npm run test:live    # model-live.sh gateway, then hooks-live.sh
```

| Script | Checks | Writes |
| --- | --- | --- |
| `scripts/model-live.sh gateway` | A real `pi -p --model grok/grok-4.7` reads and writes files. Records whether Pi or Grok executed the tools. | `evidence/model-live-gateway-<policy>.json` |
| `scripts/hooks-live.sh` | Read-only session denies an edit. A broken edit is repaired after the check context. The stop check holds the turn. | `evidence/hooks-live.json` |
| `scripts/model-probe.ts` | Grok finds and calls a Pi-only tool through the MCP relay and waits for a held result. | `evidence/model-probe.json` |
| `scripts/gateway-guard-probe.ts` | A hung Pi is denied at the ack tier. A closed Pi socket rejects. A late dialog answer after an ack is used. | `evidence/gateway-guard-probe.json` |
| `scripts/mcp-gate-probe.ts` | A marked MCP tool is allowed and an unmarked one is denied in a read-only session. | `evidence/mcp-gate-probe.json` |
| `scripts/question-probe.ts` | `ask_user_question` round trip and `/grok` command paths. | `evidence/question-probe.json` |
| `scripts/image-probe.ts` | `image_gen` result shape and file location. Inbound image by path. | `evidence/image-probe.json` |
| `scripts/queue-probe.ts [interject]` | A second prompt or an interject while a turn runs. Prints a timeline. | Standard output only |
| `scripts/reconnect-probe.ts` | Restarts the gateway, or stops the leader, between two turns. Turn 2 must keep context. | `evidence/reconnect-probe.json` or `evidence/reconnect-probe-leader.json` |
| `scripts/hooks-probe.ts` | Raw ACP hook frames around a native tool call. | `evidence/hooks-probe.json` |
| `scripts/perm-timing.ts`, `scripts/usage-probe.ts` | Permission round-trip timing and usage frames. | Standard output only |
| `scripts/mcp-list-probe.ts` | Which tool fields `_x.ai/mcp/list` keeps for a Pi-hosted MCP server (`_meta`, `annotations`). | Standard output only |
| `scripts/shell-permission-probe.ts` | What Grok does with a shell call when every permission prompt is cancelled. `PROBE_PROMPT` replaces the prompt. | Standard output only |
| `scripts/modes-probe.ts` | Session modes and the commands Grok advertises. | Standard output only |
| `scripts/cmd-probe.ts` | Grok's `/goal`, `/context`, and plan mode over raw ACP. | Standard output only |
| `scripts/detail-probe.ts` | Session detail and config in the `session/new` response, and `session_info_update` after a turn. | Standard output only |

`scripts/reconnect-probe.ts` is not isolated. It hardcodes port 2419 and reads a gateway PID from `~/.pi/agent/grok-ws.pid`, a file that `npm run server` does not write. It sends SIGTERM to that PID (gateway mode) or to its `agent leader` child (leader mode). `GROK_ACP_URL`, `PI_CODING_AGENT_DIR`, and the other variables do not change these targets. Run it only when the default gateway on 2419 is disposable and the PID file names it. Its check for other clients looks only at port 2419.

The results of the run recorded in [launch-verification.md](launch-verification.md) are not in the repository. Treat the probes as reproducible checks, and run them again for current results. Probe output and `evidence/` files can contain private paths, session IDs, and tokens. Review and redact them before you share them.

## Troubleshooting

| Symptom | Cause and action |
| --- | --- |
| `Grok gateway secret not found at …` on a Grok turn | The gateway never ran with this agent directory. Start `pi-grok-gateway` (or `npm run server` in a clone) once; it creates the file. Then send the message again. Pi does not need a restart. |
| Pi reports that the extension failed to load, with `ENOENT` for `grok-ws.secret` | A version before the lazy secret read. The gateway never ran with this agent directory. Run `npm run server` once, or set `GROK_AGENT_SECRET` in both terminals. |
| Pi does not know the model `grok/grok-4.7` | The extension did not load. Use `pi -e <path-to-clone>` or `pi install <path-to-clone>`, and check the load error at startup. |
| `Grok WebSocket handshake failed. Check the endpoint, server, and secret.` | The gateway is not running, the URL is different, or the two terminals use different secrets. Compare `GROK_ACP_URL` and `PI_CODING_AGENT_DIR` in both terminals. |
| Gateway exits with `EADDRINUSE` | The port is in use. The gateway binds its port before it starts or adopts a leader, so the other gateway keeps running. See [Run a second, isolated gateway](#run-a-second-isolated-gateway). |
| `The local launcher requires a loopback ws:// endpoint ending in /ws.` | The gateway URL is not local. The gateway serves loopback only. |
| `Grok leader socket startup timed out.` or `Grok leader exited before startup.` | Check `grok --version`, `grok login`, and `PI_GROK_BINARY`. |
| `Grok Build is not signed in. Run /grok login, ...` | Grok has no stored login. Run `/grok login` and approve the code, then send the message again. Pi's `/login` xAI entry does not sign in Grok Build: Grok authenticates agent sessions only with its own stored login, and `XAI_API_KEY` does not replace it. |
| `Grok connection dropped mid-turn (…)` | The gateway or leader restarted. Send the message again. |
| `No Grok session yet. Send a message first.` | `/grok plan`, `goal`, and `compact` need a Grok session. Send one prompt first. |
| Headless Pi ends the turn after a permission prompt | The default `headlessPermissions` is `dialog`, which cancels. Set `deny`, `reads`, or `allow`. |
| No inline image | The terminal has no image support, or `magick` is missing for a JPEG, WebP, or GIF. The path is still shown. |
| No hashline tools | `~/.grok/config.toml` does not set `[toolset] file_toolset = "hashline"`. This is expected. |
