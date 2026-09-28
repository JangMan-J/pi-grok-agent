# pi-grok-agent: agent notes

This package is a Pi extension. It registers the model provider `grok`. Grok Build runs its own harness and tools. Pi drives turns, shows the stream, answers Grok's dialogs, gates Grok's tools through client hooks, and can lend Pi tools over MCP.

Human setup and the settings reference are in `README.md`. Design notes are in `docs/first-class-model.md`. Launch copy and gates are in `docs/launch.md`. Runtime check results are in `docs/launch-verification.md`.

## Commands

Scripts are in `package.json`. Run `npm install` once before any check. The `pi` manifest loads `./src/model.ts`.

- `npm run check`: type check (`tsc --noEmit`).
- `npm test`: unit tests in `test/`, with mocks only, plus `test/gateway.test.ts`, which runs the real gateway against `test/fixtures/fake-grok.ts` in a scratch `HOME`. Nothing contacts Grok.
- `npm run server`: the gateway plus a dedicated Grok leader, on `127.0.0.1:2419` by default. The same script is the package `bin` `pi-grok-gateway` and runs from any working directory. Nothing starts it automatically.
- `npm run test:live` and the scripts in `scripts/`: live probes. They use the current Grok login and spend model usage. Run them only when the user asks. They write to `evidence/`. Create that directory first. It is not in `.gitignore`, so sanitize results before a commit (gate G7 in `docs/launch.md`). `scripts/reconnect-probe.ts` hardcodes port 2419 and `~/.pi/agent/grok-ws.pid` and stops that gateway, so it never runs isolated.

## Gateway ownership

The gateway binds its port before it starts or adopts a leader (`scripts/server.ts`, bottom). A launch that loses its port exits with `EADDRINUSE` and has touched no leader. A leader the launch spawns, or adopts once it holds the port, is its own: shutdown stops it. Keep that order. `test/gateway.test.ts` checks it with `test/fixtures/fake-grok.ts` as the Grok binary.

For an isolated gateway, set all three: `PI_GROK_LEADER_SOCKET` to a new socket path, `GROK_ACP_URL` to a free port, and `PI_CODING_AGENT_DIR` to a scratch directory. The extension reads its secret at load time (`readConfig` in `src/config.ts`). Start the gateway once before Pi loads the extension, or set `GROK_AGENT_SECRET`.

## Architecture

| File | Role |
| --- | --- |
| `src/model.ts` | Extension entry: provider registration, renderers, `/grok` command, media display, steer wiring |
| `src/model/provider.ts` | Pi transcript to ACP prompt. System prompt goes as `_meta.rules`. Only the new tail is sent. Model IDs. |
| `src/model/connection.ts` | One WebSocket per Pi process, `session/new` or `session/load`, `cached_token` auth |
| `src/model/session.ts` | ACP updates to Pi events, client hooks, media copy, lent-tool parking. `startPrompt` owns the prompt lifetime for normal turns and `/grok` commands: busy state, cancel, late-completion suppression |
| `src/model/hooks.ts` | `capabilityGate`, `postEditContext`, `stopGate` |
| `src/model/permissions.ts`, `questions.ts` | Grok permission prompts and `ask_user_question` as Pi dialogs |
| `src/model/steer.ts` | Mid-turn Enter to `_x.ai/interject` |
| `src/config.ts` | `~/.pi/agent/grok-ws.json`, environment overrides, guard validation |
| `scripts/server.ts` | Gateway: leader supervision, stdio bridge per socket, bearer auth, MCP relay at `/mcp/<token>`, `ReverseRequestGuard` (one guarded lifetime per hook, permission prompt, or question: ack tiers, one answer per request, fail closed on disconnect) |

Invariants:

- Grok native tool calls stay on Grok. They become thinking text and `grok-tool` entries, never Pi tool calls (`test/model.test.ts`).
- Custom entries and `grok-media` messages are display only. The provider never sends them to Grok.
- Grok's model context keeps full tool results. Pi's copies are shortened: 400 characters in the thinking stream, 8000 in a `grok-tool` entry, 600 in the expanded renderer.
- The gateway starts Grok in default permission mode. Keep `--always-approve` out of `LEADER_ARGS`.

## Documentation claims

Every capability claim in `README.md` or `docs/` must point to source, a unit test, or a probe result that exists. Mark a claim as unverified when its evidence file is absent. Record the Grok, Pi, and Node versions with each live result. Tracked files use repository-relative or `~/` paths only.

The license is Apache-2.0 (`LICENSE`, `license` in `package.json`). `"private": true` only blocks npm publication; the GitHub repository is public. Keep `"private": true` until the owner decides on npm publication.
