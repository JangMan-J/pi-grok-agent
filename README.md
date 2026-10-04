<h1 align="center">
  <img src="https://raw.githubusercontent.com/JangMan-J/pi-grok-agent/main/docs/assets/compact-1536x384.png" width="768" alt="pi-grok-agent: Grok's agent. Pi's workflow.">
</h1>

<p align="center">
  <a href="https://github.com/JangMan-J/pi-grok-agent/actions/workflows/ci.yml"><img src="https://github.com/JangMan-J/pi-grok-agent/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/pi-grok-agent"><img src="https://img.shields.io/npm/v/pi-grok-agent" alt="npm version"></a>
  <a href="https://github.com/JangMan-J/pi-grok-agent/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/pi-grok-agent" alt="License: Apache-2.0"></a>
</p>

```sh
pi install npm:pi-grok-agent
```

Run [Grok Build](https://docs.x.ai/build/overview) as an additional model provider in [Pi coding agent](https://github.com/earendil-works/pi). Grok keeps its native environment, tools, and session history. Pi provides the DIY harness, turn control, permission requests, and extensions.

<details>
<summary>Watch the demo (1:20)</summary>

[Play the demo video](https://github.com/user-attachments/assets/affe029e-512a-4f46-8c19-59cc625fe65e) (MP4, 80 seconds). The same file is in this repository: [evidence/pi-grok-agent-demo-finalv.mp4](https://github.com/JangMan-J/pi-grok-agent/raw/refs/heads/main/evidence/pi-grok-agent-demo-finalv.mp4).

</details>

## How it connects

```text
pi (extension) ─stdio─ pi-grok-leash ─stdio─ grok --permission-mode default agent --no-leader stdio ─HTTPS─ xAI
```

The first Grok turn starts one non-detached `pi-grok-leash` per Pi process, which spawns Grok; loading the extension alone starts nothing. The leash is a small Rust watchdog between Pi and Grok: it monitors Pi's heartbeat and denies or cancels overdue hook/dialog requests. Pi uses the [Agent Client Protocol](https://agentclientprotocol.com) over stdio; lent Pi tools ride the same pipe as MCP-over-ACP (`x.ai/mcp/sdk`, `x.ai/mcp/servers`, `_x.ai/mcp/sdk_call`). There is no shared leader, gateway, listening MCP port, or bearer secret. Sources: `src/model/connection.ts`, `leash/src/runtime.rs`; fake-child checks: `test/leash.test.ts`, `test/transport.test.ts`. Details: [architecture](docs/architecture-diagram.md) · [usage](docs/usage.md).

## Function

- Pi sets permissions and boundaries. Read-only, ask, auto, and YOLO permission modes are supported.
- Pi makes the decisions. Pi allows or denies each of Grok's tool calls. In interactive Pi, Grok's permission prompts and `ask_user_question` prompts open as Pi dialogs.
- Grok can use Pi's extension tools. They are lent over MCP, and Grok calls each one through `use_tool` as `pi__<name>`. The rules Pi sends to Grok list those names. Pi executes the tool, and the result continues the same Grok turn.
- Grok keeps all of its tools and extensions. My own observations have been that Grok performs better with its native toolset, so this project's purpose is to keep its tools without buying the shed.

## Models

| Model ID | Name in `/models` | Reasoning efforts |
| --- | --- | --- |
| `grok/grok-4.7` | Grok 4.7 | low, medium, high, xhigh |
| `grok/grok-4.7-build-fast` | Grok 4.7 Build Fast | low, medium, high, xhigh |
| `grok/grok-4.6` | Grok 4.6 | low, medium, high, xhigh |
| `grok/grok-4.5` | Grok 4.5 | low, medium, high |

Each model's context window is read from Grok Build's model cache (`~/.grok/models_cache.json`) when the extension loads. Without the cache, Pi uses 256,000 tokens.

Model availability in Pi is determined by your [account access](https://grok.com).

## Safety

- This package connects the Grok Build agent over ACP, not the xAI chat-completions API. ACP does not give complete visibility or control of an agent, and not all functions or extensions of Grok Build have been tested for safety in this configuration. The tool gates are not an operating-system sandbox: Grok runs with your user's permissions.
- Grok uses `--permission-mode default`, never `--always-approve`. MCP uses the stdio pipe, not a loopback listener. The leash kills Grok's process group after a missed heartbeat window (default 1000 ms); overdue tracked requests receive deny/cancel, never approval. `PI_GROK_LEASH=none` explicitly disables this protection and `/grok debug` says `UNGUARDED` (`leash/src/runtime.rs`, `src/model/connection.ts`, `test/leash.test.ts`). See [residual limits](docs/first-class-model.md#failure-modes), including processes outside Grok's group and abrupt Pi death. Live Grok probes with the leash have **not been run**.
- Headless use does not imply approval: by default, headless Pi cancels Grok's permission prompts. `/grok perms yolo` selects allow once (`src/model/permissions.ts`, `test/permissions.test.ts`). The `postEditCheck` and `stopCheck` settings run as shell commands, so treat them as executable code (`src/model/hooks.ts`).

## Notes

- `PI_CODING_AGENT_DIR` isolates Pi settings/sessions; `PI_GROK_BINARY` selects the child executable at spawn time. No port, socket path, or shared leader needs configuration. A new `--no-leader` child loaded a stored Grok session after a Pi restart on 2026-10-04.

- Requires the Grok Build CLI (`grok` on your `PATH`, or the path in `PI_GROK_BINARY`) and Node.js 22.19 or newer.
- The npm tarball ships a **linux-x64** leash binary (`package.json`, `.github/workflows/release.yml`). Other platforms build from a repository checkout with `npm install` and `npm run build:leash`, then set `PI_GROK_LEASH` to that binary or load the checkout. Building requires Rust **stable** (verified with rustc 1.99.0); there is no `rust-toolchain.toml`. The crate currently uses Unix APIs: other Unix targets are unverified, and Windows is unsupported (`leash/README.md`, `leash/src/runtime.rs`).
- Not compatible with API key access: Grok Build accepts only its own stored login for agent sessions. A Grok account is required, any membership tier; a free account had only `grok-4.7` in the [recorded run](https://github.com/JangMan-J/pi-grok-agent/blob/main/docs/launch-verification.md). If your login expires, run `grok login` or `/login` in Grok Build, or `/grok login` in Pi, to renew it.
- The input, output, cache read, and cache write token counts and the cost shown in Pi come from Grok Build's usage report. Pi may occasionally report inaccurate data during long multistep tool calls, but will correct on the next turn.

## Documentation

- [docs/usage.md](https://github.com/JangMan-J/pi-grok-agent/blob/main/docs/usage.md): settings, lent tools, permissions, the leash watchdog, hooks, `/grok` commands, troubleshooting
- [docs/architecture-diagram.md](https://github.com/JangMan-J/pi-grok-agent/blob/main/docs/architecture-diagram.md): the diagram in mermaid and ASCII
- [docs/first-class-model.md](https://github.com/JangMan-J/pi-grok-agent/blob/main/docs/first-class-model.md): design and turn mapping
- [docs/launch-verification.md](https://github.com/JangMan-J/pi-grok-agent/blob/main/docs/launch-verification.md): recorded live runs and their versions (raw results are not in the repository)

## Feedback

[Open an issue](https://github.com/JangMan-J/pi-grok-agent/issues) with the output of `node --version`, `pi --version`, and `grok --version`, the model ID, and a short redacted excerpt of `/grok debug`.

## License

[Apache License 2.0](https://github.com/JangMan-J/pi-grok-agent/blob/main/LICENSE)
