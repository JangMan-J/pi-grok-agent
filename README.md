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
┌─────────────────────┐         ┌──────────────────┐         ┌─────────────────────┐
│ PI — drives turn    │         │ GATEWAY          │         │ GROK BUILD — works  │
│ transcript, gates,  │  ACP    │ one per machine  │  stdio  │ own tools, agents,  │
│ dialogs             │ over WS │ 127.0.0.1:2419   │         │ own history         │
│ grok provider ext   │◄───────►│ guard + MCP      │◄───────►│ ~/.grok login       │
└─────────────────────┘         └──────────────────┘         └─────────────────────┘
```

Pi drives the session using the [Agent Client Protocol](https://agentclientprotocol.com) over WebSockets. Grok streams back its responses and thinking blocks, and Pi shows the images Grok generates. A generated video shows as a file path. Grok runs its own tools, but asks Pi through a hook before each call, and Pi can allow or deny it. Pi's extension tools are lent to Grok over an MCP loopback. The first Grok turn auto-starts the local gateway (`127.0.0.1:2419` by default); every Pi process on the machine attaches to it. Details: [docs/architecture-diagram.md](https://github.com/JangMan-J/pi-grok-agent/blob/main/docs/architecture-diagram.md) · [docs/usage.md](https://github.com/JangMan-J/pi-grok-agent/blob/main/docs/usage.md).

## Function

- Pi sets permissions and boundaries. Read-only, ask, auto, and YOLO permission modes are supported.
- Pi makes the decisions. Pi allows or denies each of Grok's tool calls. In interactive Pi, Grok's permission prompts and `ask_user_question` prompts open as Pi dialogs.
- Grok can use Pi's extension tools. They are lent over MCP with `pi_`-prefixed names and mapped back to the original Pi tool names when Pi executes them; the result continues the same Grok turn.
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
- The gateway listens on loopback only, requires a bearer secret, and never starts Grok with `--always-approve`. Headless use does not imply approval: by default, headless Pi cancels Grok's permission prompts. `/grok perms yolo` selects allow once for those prompts. The `postEditCheck` and `stopCheck` settings run as shell commands, so treat them as executable code.

## Notes

- Requires the Grok Build CLI (`grok` on your `PATH`, or the path in `PI_GROK_BINARY`) and Node.js 22.19 or newer.
- Not compatible with API key access: Grok Build accepts only its own stored login for agent sessions. A Grok account is required, any membership tier; a free account had only `grok-4.7` in the [recorded run](https://github.com/JangMan-J/pi-grok-agent/blob/main/docs/launch-verification.md). If your login expires, run `grok login` or `/login` in Grok Build, or `/grok login` in Pi, to renew it.
- The input, output, cache read, and cache write token counts and the cost shown in Pi come from Grok Build's usage report. Pi may occasionally report inaccurate data during long multistep tool calls, but will correct on the next turn.

## Documentation

- [docs/usage.md](https://github.com/JangMan-J/pi-grok-agent/blob/main/docs/usage.md): settings, lent tools, permissions, the gateway guard, hooks, `/grok` commands, troubleshooting
- [docs/architecture-diagram.md](https://github.com/JangMan-J/pi-grok-agent/blob/main/docs/architecture-diagram.md): the diagram in mermaid and ASCII
- [docs/first-class-model.md](https://github.com/JangMan-J/pi-grok-agent/blob/main/docs/first-class-model.md): design and turn mapping
- [docs/launch-verification.md](https://github.com/JangMan-J/pi-grok-agent/blob/main/docs/launch-verification.md): recorded live runs and their versions (raw results are not in the repository)

## Feedback

[Open an issue](https://github.com/JangMan-J/pi-grok-agent/issues) with the output of `node --version`, `pi --version`, and `grok --version`, the model ID, and a short redacted excerpt of `/grok debug`.

## License

[Apache License 2.0](https://github.com/JangMan-J/pi-grok-agent/blob/main/LICENSE)
