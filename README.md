<h1 align="center">
  <img src="https://raw.githubusercontent.com/JangMan-J/pi-grok-agent/main/docs/assets/compact-1536x384.png" width="768" alt="pi-grok-agent — Grok's agent. Pi's workflow.">
</h1>

```sh
pi install npm:pi-grok-agent
```

Run [Grok Build](https://docs.x.ai/build/overview) as an additional model provider in [Pi coding agent](https://github.com/earendil-works/pi). Grok keeps its native environment, tools, and session history. Pi provides the DIY harness, turn control, permission requests, and extensions.

<details>
<summary>Watch the demo (1:20)</summary>

https://github.com/user-attachments/assets/affe029e-512a-4f46-8c19-59cc625fe65e

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

Pi drives the session using [Agent Client Protocol](https://agentclientprotocol.com) over WebSockets. Grok returns streaming responses, thinking blocks, as well as image and video requests. All of Grok's tool requests are routed back to Pi through callbacks over an MCP loopback. The first Grok turn auto-starts the local gateway (`127.0.0.1:2419` by default) ; every Pi process on the machine attaches to it. Details: [docs/architecture-diagram.md](docs/architecture-diagram.md) · [docs/usage.md](docs/usage.md).

## Function

- **Pi sets permissions and boundaries.** Read-only, ask, auto, and YOLO permission modes are supported. 
- **Pi makes decisions.** Grok's tool call requests, turn order, user_ask_question prompts are delegated to Pi.
- **Grok can use Pi's extension tools** Lent over MCP as `pi__<name>`, with the result continuing the same Grok turn.
- **Grok keeps all of its tools and extensions.** My own observations have been that Grok performs better with its native toolset, so this project's purpose is to keep its tools without buying the shed.

## Models

| Model ID | Name in `/models` | Reasoning efforts | Context window |
| --- | --- | --- | --- |
| `grok/grok-4.7` | Grok 4.7 | low, medium, high, xhigh | 500,000 tokens |
| `grok/grok-4.7-build-fast` | Grok 4.7 Build Fast | low, medium, high, xhigh | 500,000 tokens |
| `grok/grok-4.6` | Grok 4.6 | low, medium, high, xhigh | 500,000 tokens |
| `grok/grok-4.5` | Grok 4.5 | low, medium, high | 500,000 tokens |


Model availability in Pi is determined by your [account access](https://grok.com).

## Safety

- This package connects the Grok Build agent over ACP, not the xAI chat-completions API. The ACP protocol does not provide complete visibility or control of an agent, and not all functions or extensions of Grok Build have been tested for safety in this configuration. The tool gates are not an operating-system sandbox: Grok runs with your user's permissions. 
- The gateway listens on loopback only, requires a bearer secret, and never starts Grok with `--always-approve`. Headless use does not imply approval: by default, headless Pi cancels Grok's permission prompts. `/grok perms yolo` selects allow once for those prompts. The `postEditCheck` and `stopCheck` settings run as shell commands — treat them as executable code.

## Notes

- Not compatible with API key access. A Grok account is required, any membership tier. If your OAuth token expires you can '/login' from either Grok Build or Pi with '/grok login' to renew credentials.
- Token read, token write, cache read and cache hit % displayed in Pi are taken from Grok Build. Pi may occasionally report inaccurate data during long multistep tool calls, but will correct on the next turn.

## Documentation

- [docs/usage.md](docs/usage.md) — settings, lent tools, permissions, the gateway guard, hooks, `/grok` commands, troubleshooting
- [docs/architecture-diagram.md](docs/architecture-diagram.md) — the diagram in mermaid and ASCII
- [docs/first-class-model.md](docs/first-class-model.md) — design and turn mapping
- [docs/launch-verification.md](docs/launch-verification.md) — recorded live runs behind the verified claims

## Feedback

- [Open an issue](https://github.com/JangMan-J/pi-grok-agent/issues) with the output of `node --version`, `pi --version`, and `grok --version`, the model ID, and a short redacted excerpt of `/grok debug`.

## License

- [Apache License 2.0](LICENSE).
