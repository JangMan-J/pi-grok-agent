# Grok Build as a Pi model

This package registers the model provider `grok`. Pi drives the conversation; Grok Build runs on its own harness.
Grok keeps its native tools (hashline edits, shell, subagents, web, media), its permission rules, and its history on a shared Grok leader.
Pi shows the stream, records each Grok tool call, answers Grok's questions and permission prompts, and can gate or lend tools.

```text
Pi ──WebSocket ACP──► gateway ──stdio──► grok agent leader
Pi ◄──HTTP MCP (gateway relay)── leader        (lent Pi tools only)
```

## Start

Requirements: Node.js 22.18 or later, Pi 0.87 or later, an authenticated Grok Build CLI, and ImageMagick (`magick`) for inline images.
Verified with Node.js 26.10, Pi 0.87.1, Grok Build 1.0.41.

```sh
pi install ~/JangLabs/pi-grok-agent
cd ~/JangLabs/pi-grok-agent && npm run server     # gateway + dedicated Grok leader, in its own terminal
pi --model grok/grok-4.7
```

The launcher creates `~/.pi/agent/grok-ws.secret` (mode 0600) and listens on `127.0.0.1:2419`.
It starts Grok in default permission mode, never with `--always-approve`. Ctrl+C stops the gateway, its clients, and its leader.
The leader socket is `~/.grok/pi/leader.sock`, outside Grok's `leader-*.sock` discovery, so the Grok TUI does not attach to it.

After a change under `src/model/`, start a fresh `pi`. `/reload` re-runs the extension but can keep the already imported provider module.

## The model


Select the model like any other:

```sh
pi --model grok/grok-4.7
```

Fabric workers use the same ID, for example `agents.run({ model: "grok/grok-4.7" })`.

Grok runs on its own harness: its native tools, permission rules, subagents, and history.
File edits use Grok's native hashline toolset (`hashline_read`, `hashline_edit`, `hashline_grep`).
That toolset comes from `[toolset] file_toolset = "hashline"` in `~/.grok/config.toml`, which also applies to the Grok TUI.
The `GROK_CONFIG` overlay cannot set this key, so the setting is global.
Pi drives the turns, streams the answer, and shows Grok's tool activity as thinking blocks.
Pi does not execute those tools. Grok's permission prompts appear as Pi dialogs.
The design and evidence are in `docs/first-class-model.md`.

Models: `grok-4.7`, `grok-4.7-build-fast`, `grok-4.6`, `grok-4.5`. Cost metadata is zero.
Pi compaction and Grok compaction are separate. The provider sends only new messages.

Pi can lend extra tools to Grok. Setting `piTools` in `~/.pi/agent/grok-ws.json`, or `PI_GROK_PI_TOOLS`, selects them:

| Value | Tools offered to Grok |
| --- | --- |
| `extensions` (default) | Pi tools other than `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` |
| `none` | No Pi tools |
| `all` | Every Pi tool |
| `a,b,c` | The named tools |

Offered tools appear to Grok as `pi__<name>`. When Grok calls one, Pi executes it through its own loop and permission gates.
Grok reads the offered list once per session. A changed tool set needs a new Pi session.
When Grok has an equivalent native tool, it usually prefers its own.

Lent tools reach Grok as an ordinary HTTP MCP server. The gateway serves it at `http://127.0.0.1:2419/mcp/<token>`.
The gateway relays each MCP message to the Pi connection that registered the token.
Grok connects to that server itself, so the stock binary works and the leader router is not involved.
The forked branch `pi/sdk-call-session-id` in `~/JangLabs/scratch/grok-build` remains as a record of the in-process alternative. It is not required.

Grok asks permission for some native tools, for example a shell redirect that writes a file.
Interactive Pi shows the dialog. Headless Pi (`-p`, Fabric workers) uses `headlessPermissions`, or `PI_GROK_HEADLESS_PERMISSIONS`:

| Value | Headless answer |
| --- | --- |
| `dialog` (default) | Cancel the prompt. Grok reports the tool as cancelled and ends the turn. |
| `deny` | Reject once. |
| `reads` | Allow read, search, fetch, and think prompts. Reject the rest. |
| `allow` | Allow once. |

A rejected or cancelled prompt ends the Grok turn normally. Pi sees a completed message, not an abort.

### Gateway guard

When a client hook times out, Grok fails open. On a permission prompt, Grok waits with no limit.
The gateway therefore answers on Pi's behalf when Pi cannot, in tiers:

| Tier | Condition | Answer |
| --- | --- | --- |
| 0 | Pi answers | Pi's answer |
| 1 | Pi sent `pi/gate-ack` with `dialog: true` | wait `dialogMs`, then reject |
| 1 | Pi sent `pi/gate-ack` with `check: true` | wait `checkBudgetMs`, then continue |
| 1 | Pi sent `pi/gate-ack` without flags | wait `policyMs`, then deny or reject |
| 2 | No ack within `ackMs`, or the Pi socket closed | deny (`pre_tool_use`), continue (`post_tool_use`, `stop`), reject (permission) |

Settings in `~/.pi/agent/grok-ws.json` under `guard`: `ackMs` (5000), `policyMs` (15000), `checkBudgetMs` (590000), `dialogMs` (600000).
Environment overrides: `PI_GROK_ACK_MS`, `PI_GROK_POLICY_MS`, `PI_GROK_CHECK_BUDGET_MS`, `PI_GROK_DIALOG_MS`.
The gateway refuses values that let Grok's own deadline expire first. Measured round trips on loopback take less than 1 ms.

### Grok questions, commands, and media

When Grok calls `ask_user_question`, Pi shows one dialog per question with the options, `Other` for free text, and in plan mode `Chat about this` and `Skip interview`.
Headless Pi answers `cancelled`, which Grok's tool reports to the model as unanswered.

`/grok` gives manual access to Grok harness features:

| Command | Effect |
| --- | --- |
| `/grok plan on` and `/grok plan off` | `session/set_mode` plan or default |
| `/grok goal <objective>`, `goal status`, `goal pause`, `goal resume`, `goal clear` | Grok's `/goal` command, outside Pi's model loop |
| `/grok compact [note]` | Grok's `/compact` on its own history |
| `/grok debug` | Grok session id, mode, lent tools, hook counts, from Pi's state |

Generated media (`image_gen`, `image_edit`, `image_to_video`) is copied into `mediaDir`, default `.pi/grok-images/` under the Pi cwd with a `.gitignore`.
The tool entry shows the copy's path. After the turn, a `grok-media` message shows the image inline where the terminal supports it, through Pi's normal image path. The expanded message also shows Grok's original path.
These messages are display only. The provider never sends custom messages to Grok, so a generated image is not read back as an attachment.
JPEG output is converted to PNG with ImageMagick for display, since pi-tui sends kitty images as PNG. Set `mediaDir` to an empty string to keep Grok's path only.
Images attached to a Pi message reach Grok as a temp file path, which Grok reads with its own tools.

If the gateway restarts under a live session, the next turn reconnects and loads the same Grok session. The turn in flight at the drop is lost.
Escape aborts the Grok turn and frees the session; the next message starts a fresh prompt.

Usage comes from Grok's own accounting per turn: input, cached input, output, and Grok's reported cost. The footer's cache percentage and cost are real. The context window is 500k.

### Hooks around Grok's tools

The provider registers Grok client hooks for every model session. Grok still executes each tool. Pi decides and annotates around it.

| Hook | What Pi does |
| --- | --- |
| `pre_tool_use` | Mirrors Pi's own tool set onto Grok. A Pi session without `edit` or `write` denies Grok's edit tools. A session without `bash` denies Grok's shell. The deny reason reaches the model. |
| | Classification uses Grok's own `x.ai/tool` stamp (kind and `read_only`) on each call, with a name table as fallback. A stamped mutating kind the table does not know is denied in a read-only session. |
| | MCP and plugin tools arrive as `server__tool` and are stamped as the `use_tool` dispatcher. In a read-only session they are denied unless the tool's `_meta` marks it read-only or the server is in `mcpReadOnlyServers`. Grok 1.0.41 drops MCP `annotations`, so `readOnlyHint` must be mirrored into `_meta`. Lent Pi read tools do this. |
| `post_tool_use` | After a Grok edit, runs a syntax check on the file (TypeScript, JavaScript, Python, JSON, Rust) or the configured `postEditCheck`. A failure returns to the model as extra context in the same turn. |
| `stop` | Runs the configured `stopCheck`. A non-zero exit blocks the end of turn with the output as the reason, up to Grok's eight-continuation cap. |
| `post_tool_use_failure` | Records the failure in the transcript. |

Each Grok tool call becomes a `grok-tool` session entry with the tool, input, status, output, and duration.
The interactive transcript renders one line per call. These entries are not sent to any model.

Settings in `~/.pi/agent/grok-ws.json` under `hooks`, with environment overrides:

```json
{
  "hooks": {
    "denyGrokTools": ["web_search", "image_.*", "linear__.*"],
    "allowGrokTools": ["run_terminal_command"],
    "mcpReadOnlyServers": ["context7", "docs"],
    "postEditCheck": "npx tsc --noEmit -p .",
    "stopCheck": "npm test"
  }
}
```

`PI_GROK_DENY_TOOLS`, `PI_GROK_POST_EDIT_CHECK`, and `PI_GROK_STOP_CHECK` set the same values for one process.
`{file}` in `postEditCheck` is the edited file. Precedence: `denyGrokTools`, then `allowGrokTools`, then a tool's `_meta` read-only marker, then `mcpReadOnlyServers`, then the capability mirror.
Hook failures fail open, as Grok's own hooks do.

## Slash commands

`/grok` covers only what Pi has no native surface for. `/grok` with no subcommand sends nothing. The menu under the editor shows each subcommand with its arguments: `(yolo | auto | ask | read-only)`, `(on | off)`, `(<objective> | status | pause | resume | clear)`, `(note)`, `(brilliant information)`.

| Command | Effect |
| --- | --- |
| `/grok debug` | gateway, Grok session, mode, permissions, Grok context size, usage and cost, lent tools, hook counts |
| `/grok perms`, then `yolo`, `auto`, `ask`, or `read-only` | Pi-side gate for Grok's native tools, applied before Grok's own rules. `yolo` allows everything with no dialogs, for autonomous work. `auto` mirrors Pi's tool set. `read-only` denies edits and shell. `ask` shows a Pi confirm dialog for every edit or shell call; without a UI it behaves as `read-only`. |
| `/grok plan on` and `/grok plan off` | enter or leave Grok plan mode (`session/set_mode`) |
| `/grok goal <objective>`, `goal status`, `goal pause`, `goal resume`, `goal clear` | Grok's `/goal`. This is a Grok turn. |
| `/grok compact [note]` | compact Grok's own history. This is a Grok turn. Pi's `/compact` compacts Pi's transcript, which is separate. |

Pi's own controls apply as usual: Escape cancels the Grok turn, `/new` starts a fresh Pi and Grok session, and the thinking level (Shift+Tab or `/thinking`) sets Grok's reasoning effort. Grok 4.7, 4.7-build-fast, and 4.6 offer low, medium, high, and xhigh; 4.5 offers low, medium, and high.
A dropped gateway socket reconnects on the next turn.

## Settings

Optional settings in `~/.pi/agent/grok-ws.json`:

```json
{
  "url": "ws://127.0.0.1:2419/ws",
  "secretFile": "~/.pi/agent/grok-ws.secret",
  "piTools": "extensions",
  "headlessPermissions": "dialog",
  "mediaDir": ".pi/grok-images",
  "grokMode": "default",
  "hooks": { "denyGrokTools": [], "allowGrokTools": [], "mcpReadOnlyServers": [], "postEditCheck": "", "stopCheck": "" },
  "guard": { "ackMs": 5000, "policyMs": 15000, "checkBudgetMs": 590000, "dialogMs": 600000 }
}
```

`grokMode` sets Grok's own permission mode for sessions the provider creates: `default` or `auto` (Grok's auto permission mode). It is independent of `/grok perms`, which is Pi's gate. A common pairing for autonomous work is `/grok perms yolo` with `grokMode: auto`.

Environment overrides: `GROK_ACP_URL`, `PI_GROK_GROK_MODE`, `GROK_AGENT_SECRET`, `PI_GROK_PI_TOOLS`, `PI_GROK_HEADLESS_PERMISSIONS`, `PI_GROK_MEDIA_DIR`,
`PI_GROK_DENY_TOOLS`, `PI_GROK_POST_EDIT_CHECK`, `PI_GROK_STOP_CHECK`, `PI_GROK_ACK_MS`, `PI_GROK_POLICY_MS`, `PI_GROK_CHECK_BUDGET_MS`, `PI_GROK_DIALOG_MS`,
`PI_GROK_LEADER_SOCKET`, `PI_GROK_BINARY`, `PI_CODING_AGENT_DIR`.
Non-loopback connections require `wss://`. The client sends the secret in an Authorization header, never in the URL.

## Lifecycle

The extension stores the Grok session ID in the Pi session, outside model context. Reload and reconnect use `session/load`.
A fork does not inherit another Pi session's Grok session. Tree navigation starts a new mapping.
If the gateway restarts under a live session, the next turn reconnects and loads the same Grok session. The turn in flight at the drop is lost.
Grok's session directory is not a sandbox. Grok runs with the permissions of its operating-system user.

## Verification

```sh
npm run check
npm test
npm run test:live          # model-live.sh gateway, then hooks-live.sh; uses the current Grok login and incurs model usage
```

Live probes, each against the running gateway:

| Script | Checks | Evidence |
| --- | --- | --- |
| `scripts/model-live.sh gateway` | a real `pi -p --model grok/grok-4.7` reads and writes files on Grok's harness; records which side ran each tool | `evidence/model-live-gateway-*.json` |
| `scripts/hooks-live.sh` | read-only session denied an edit; broken edit repaired after the check; stop gate holds the turn | `evidence/hooks-live.json` |
| `scripts/model-probe.ts` | Grok discovers and calls a Pi-only tool through the gateway MCP relay, with a held result | `evidence/model-probe-http-stock-leader.json` |
| `scripts/gateway-guard-probe.ts` | hung Pi denied at the ack tier; vanished Pi rejected; acked dialog answered late is honored | `evidence/gateway-guard-probe.json` |
| `scripts/mcp-gate-probe.ts` | marked MCP tool allowed, unmarked denied, in a read-only session | `evidence/mcp-gate-probe.json` |
| `scripts/question-probe.ts` | `ask_user_question` round trip and `/grok` command paths | `evidence/question-probe.json` |
| `scripts/reconnect-probe.ts` | gateway restarted between two turns; turn 2 reconnects with context. Refuses to run with a client attached | `evidence/reconnect-probe.json` |
| `scripts/image-probe.ts` | `image_gen` result shape and file location; inbound image by path | `evidence/image-probe.json` |
| `scripts/hooks-probe.ts`, `perm-timing.ts`, `usage-probe.ts` | raw ACP hook, timing, and usage frames | `evidence/hooks-probe*.json` |

Unit tests cover the turn split around a lent tool call, abort and abort-then-resend, custom messages excluded from prompts, usage mapping, hook classification and gates, guard tier validation, question dialogs, and media copies.

Design notes and the verification ledger are in `docs/first-class-model.md`. Dependencies: the official ACP TypeScript SDK 1.5.0 and `ws` 8.22.0.
