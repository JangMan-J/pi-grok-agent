# pi-grok-agent

Grok's agent. Pi's workflow.

Run Grok Build as a model in the [Pi coding agent](https://github.com/earendil-works/pi).
Grok keeps its native tools and history. You keep Pi's transcript, extensions, and permission dialogs.

[Quick start](#quick-start) · [First result](#first-result) · [Reference](docs/usage.md) · [Limitations](#limitations) · [Apache-2.0](LICENSE)

After [setup](#quick-start), select Grok like any Pi model:

```sh
pi --model grok/grok-4.7
```

Status: version 0.1.0. Developed and tested on Linux with Node.js 26.10.0, Pi 0.87.1, and Grok Build 1.0.41. Other versions and platforms are untested.

This package connects an agent, not the xAI chat-completions API. It needs a logged-in Grok Build CLI and a local gateway.
The tool gates are not an operating-system sandbox.

## Requirements

| Item | Requirement |
| --- | --- |
| Node.js and npm | Node.js 22.19 or later is Pi's minimum. This package is tested only on 26.10.0. |
| [Pi](https://github.com/earendil-works/pi#quick-start) | Tested with 0.87.1. Other versions are untested. |
| [Grok Build CLI](https://docs.x.ai/build/overview) | `grok` on `PATH`, or its path in `PI_GROK_BINARY`. |
| Grok login | Run `grok login` before the first start. This package has no login flow. It uses Grok's cached token when Grok offers the `cached_token` method. |
| Free local port | `127.0.0.1:2419`, or another loopback port in `GROK_ACP_URL`. |
| Optional | A terminal with inline image support. ImageMagick 7 (`magick`) to show JPEG, WebP, and GIF images inline. PNG needs no converter. |

Grok usage counts against your Grok account. Pi shows the cost that Grok reports for each turn.

## Quick start

```sh
pi install npm:pi-grok-agent
pi --model grok/grok-4.7
```

The first Grok turn starts the local gateway that comes with the package and waits for it, about 5 seconds. The gateway keeps running after Pi exits, and every Pi process on the machine shares it. Its first start creates the shared secret `~/.pi/agent/grok-ws.secret` with mode 0600. [Gateway auto-start](docs/usage.md#gateway-auto-start) explains how to stop it, or how to run it yourself with `npm install -g pi-grok-agent` and `pi-grok-gateway`.

Pi loads the extension at every start, for every model. To remove it, run `pi remove npm:pi-grok-agent`.

### From a clone

```sh
git clone https://github.com/JangMan-J/pi-grok-agent.git
cd pi-grok-agent
npm install --omit=dev
npm run server              # terminal A: the gateway
pi -e . --model grok/grok-4.7   # terminal B: this Pi process only; or pi install . for every session
```

`pi install git:github.com/JangMan-J/pi-grok-agent` also works. A clone auto-starts the gateway from its own checkout, so `npm run server` is optional. A git install uses the same code path, but that is not yet tested live.

## First result

Start Pi in any project directory that has a `package.json`, and send this prompt:

```text
Read package.json and tell me the package name and the npm scripts. Do not change files.
```

Expected result:

- One line for each Grok tool call, for example `✓ grok read_file …` or `✓ grok hashline_read …`, with its duration. Grok chooses the tool.
- Thinking text that contains `[grok <tool>]` lines.
- An answer that names the package and its scripts.
- A footer cost that comes from Grok's usage report.

Then run `/grok debug`. It shows the gateway connection, the Grok session ID, the permission modes, token usage, and the lent Pi tools.

If the result is different, see [Troubleshooting](docs/usage.md#troubleshooting). Please report what you saw, as described in [Feedback](#feedback).

## Why use this?

For Pi users who want Grok Build's native tools in their existing agent workflow:

| You want to… | What this package adds |
| --- | --- |
| Keep Grok's native tools | Grok runs its own harness. Pi shows its tool calls in the transcript. |
| Control edits from Pi | [Pi's tool gate](docs/usage.md#grok-permission-prompts) can deny Grok's edit and shell tools or ask before each call. |
| Reuse Pi extension tools | [Lent tools](docs/usage.md#lent-pi-tools) reach Grok over MCP. Pi executes those calls. |

```text
Pi ⇄ local ACP gateway ⇄ Grok Build
                         └─ native tools and agent history
```

The gateway carries the Agent Client Protocol (ACP) over WebSocket and stdio. [How it works →](docs/usage.md#components)

### More controls

- Grok's native tools do the work. Grok executes the tools its harness offers, such as file, shell, search, web, subagent, and media tools. Pi does not execute them.
- Grok keeps the full tool results in its own context. Pi shows a shortened copy: 400 characters in the thinking stream, up to 8000 characters in the stored `grok-tool` entry, and up to 600 characters in the expanded entry.
- Grok's permission prompts become Pi dialogs. Grok's `ask_user_question` becomes Pi dialogs, one per question.
- Pi can gate Grok's tools. By default, a Pi session without `edit` or `write` denies Grok's edit tools, and a session without `bash` denies Grok's shell. `/grok perms read-only`, `ask`, `auto`, and `yolo` change this gate. A `denyGrokTools` entry always wins. Grok's own permission prompts are separate ([details](docs/usage.md#grok-permission-prompts)).
- Optional checks run around Grok's tools. After a Grok edit, a syntax check runs on the file. A failure goes back to Grok in the same turn. A configured `stopCheck` can hold the end of a turn.
- Pi can lend its extension tools to Grok. They appear to Grok as `pi__<name>`, and Pi executes them.
- Mid-turn Enter sends the text to Grok's `_x.ai/interject` method. Its effect on the running turn is not yet verified live. Alt+Enter queues a follow-up turn, as usual in Pi.
- Pi's thinking level sets Grok's reasoning effort. Escape cancels the Grok turn.
- Grok plan mode, `/goal`, and `/compact` are available through `/grok plan`, `/grok goal`, and `/grok compact`.

Models: `grok/grok-4.7`, `grok/grok-4.7-build-fast`, `grok/grok-4.6`, `grok/grok-4.5`. Each has a 500,000-token context window.

## Generated images and video

When a Grok tool result has the type `ImageGen`, `ImageEdit`, `ImageToVideo`, `ReferenceToVideo`, or `VideoGen`, Pi copies the file to `.pi/grok-images/` in the Pi working directory. That directory gets a `.gitignore` that ignores everything in it.

After the turn, Pi shows a `grok-media` message with the file path. PNG, JPEG, WebP, and GIF images also show inline when the terminal supports images. PNG shows directly. Pi converts JPEG, WebP, and GIF to PNG with `magick` first. Without `magick`, you see only the path for those formats. Video files show as a path only. Pi does not play video.

Live probes cover `image_gen` only (`evidence/image-probe.json`, run recorded in [docs/launch-verification.md](docs/launch-verification.md)). The image-edit and video result types are recognized in code but not yet probed with a live Grok run. The media message is for display only. Pi does not send it back to Grok.

Images that you attach in Pi go to Grok as a temporary file path under the system temp directory (`pi-grok-images`). Grok reads the file with its own tools.

## Limitations

- The auto-started gateway runs until you stop it or log out. With auto-start off, the gateway must run before the first Grok turn; until it has created its secret file, Grok turns fail with a message that names the file and the command.
- Run one gateway for each port and leader socket. A second `npm run server` with the default settings exits with `EADDRINUSE` and leaves the running gateway and its leader alone. [Run a separate gateway](docs/usage.md#run-a-second-isolated-gateway) for a demo or a test.
- Grok's native tool calls are not Pi tool calls. Pi records them as thinking text and `grok-tool` entries, and no model receives those entries.
- Pi compaction and Grok compaction are separate. Pi sends only the new messages of each turn. Only when it creates a new Grok session does it also send the earlier Pi transcript as text, cut to the last 60,000 characters.
- Grok reads the lent Pi tool list once for each Grok session. A changed tool set needs a new Pi session.
- A gateway restart loses the turn in progress. The next turn reconnects and loads the same Grok session.
- Hashline edits (`hashline_read`, `hashline_edit`, `hashline_grep`) occur only when `~/.grok/config.toml` sets `[toolset] file_toolset = "hashline"`. Otherwise Grok uses tools such as `read_file` and `search_replace`.
- After a switch from `grok/*` to another model in the same Pi session, mid-turn Enter goes to that model, not to the earlier Grok session. The Grok session stays stored and is used again when you switch back.
- The provider does not call Pi's `onPayload` and `onResponse` stream hooks.
- Cost per token is set to zero in the model metadata. The per-turn cost comes from Grok's report.

## Safety

- Grok runs with the permissions of your operating-system user. The Grok session directory is not a sandbox.
- The gateway listens on loopback only and requires the bearer secret for the WebSocket. It never starts Grok with `--always-approve`. Grok sessions use Grok's `default` permission mode unless you set `grokMode`.
- `/grok perms yolo`, `grokMode: "yolo"` or `"auto"`, and `headlessPermissions: "allow"` each remove a check. Use them only in a workspace you can lose. [usage.md](docs/usage.md#grok-permission-prompts) explains how they differ.
- Pi sends its system prompt to Grok as session rules. Pi sends user messages and, for a new Grok session, the earlier Pi transcript.
- `postEditCheck` and `stopCheck` run as shell commands (`bash -lc`) in the working directory.
- Pi packages run code with your permissions. Read the source before you install it.

Files and network endpoints are listed in [docs/usage.md](docs/usage.md#files-and-network).

## Documentation

- [docs/usage.md](docs/usage.md): settings, lent tools, permissions, gateway guard, hooks, `/grok` commands, isolated gateway, checks, and troubleshooting.
- [docs/first-class-model.md](docs/first-class-model.md): design, turn mapping, and the development record.
- [docs/demo.md](docs/demo.md): a reproducible storyboard for a 30 to 60 second demo.

## Checks

```sh
npm install          # development dependencies, including TypeScript
npm run check        # tsc --noEmit
npm test             # unit tests plus gateway tests against a fake grok binary, no Grok calls
```

`test/gateway.test.ts` starts the real gateway with `test/fixtures/fake-grok.ts` as the Grok binary. It checks leader ownership at startup and shutdown, and the guard's answers on Pi's wire: one answer per request, the deadline for each tier, and fail-closed on disconnect.

The live probes in `scripts/` use your Grok login, cost Grok usage, and write results to `evidence/`. Create that directory first. See [Live probes](docs/usage.md#live-probes).

## Relation to other ACP clients

Grok Build can serve ACP to any ACP client. This package connects that agent to Pi as a model provider. Pi's transcript, dialogs, tool gates, lent tools, and model selection then apply to Grok's own harness.

## For coding agents

To evaluate or set up this package, use the [requirements](#requirements), [quick start](#quick-start), and [first-result check](#first-result).
The [reference](docs/usage.md) lists exact settings and commands.
Headless use needs attention: the default policy cancels Grok permission prompts, and questions receive a cancelled answer.
Read [headless permission behavior](docs/usage.md#grok-permission-prompts) before unattended use. Do not assume automatic approval.
For changes to this repository, read [AGENTS.md](AGENTS.md). It contains the source map and test commands.

## Feedback

[Report a first-run problem](https://github.com/JangMan-J/pi-grok-agent/issues/new?template=first-run.yml), or [open an issue](https://github.com/JangMan-J/pi-grok-agent/issues). Include the output of `node --version`, `pi --version`, and `grok --version`, the model ID, the prompt, what you expected, and what you saw. The `/grok debug` output helps.

Before you post, remove secrets, tokens, session IDs, and private paths from all output. Do not attach raw logs or session files. Post a short excerpt that you have read, preferably from a synthetic demo project.

## License

[Apache License 2.0](LICENSE).
