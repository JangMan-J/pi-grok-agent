# pi-grok-agent: agent notes

This package is a Pi extension. It registers the model provider `grok`. Grok Build runs its own harness and tools. Pi drives turns, shows the stream, answers Grok's dialogs, gates Grok's tools through client hooks, and can lend Pi tools over MCP.

Human setup and the settings reference are in `README.md`. Design notes are in `docs/first-class-model.md`. Launch copy and gates are in `docs/launch.md`. Runtime check results are in `docs/launch-verification.md`.

## Commands

Scripts are in `package.json`. Run `npm install` once before any check. The `pi` manifest loads `./src/model.ts`.

- `npm run check`: type check (`tsc --noEmit`).
- `npm test`: unit tests plus `test/transport.test.ts`, which starts the real connection against `test/fixtures/fake-grok.ts`. Nothing contacts Grok.
- `npm pack --dry-run`: the `files` list in `package.json` decides the tarball. Keep `evidence/`, `test/`, and the probe scripts out of it.
- Live probes use the current Grok login and spend usage: run only when the user asks. `scripts/model-probe.ts` and `scripts/reconnect-probe.ts` passed on `7c26faa` (Grok 1.0.46, Pi 1.0.2, Node 26.10); see `docs/launch-verification.md`. Obsolete gateway probes exit 2. `npm run test:live` runs the two adapted probes. Results go to ignored `evidence/`; keep the tracked demo video until a release points elsewhere.

## Child ownership

`src/model/connection.ts` starts one non-detached `grok --permission-mode default agent --no-leader stdio` child per connection. No leader, daemon, fixed ACP port, or secret file. `drop()` and `close()` end only that child. `PI_GROK_BINARY` and `PI_CODING_AGENT_DIR` are inherited at spawn time. Loading the extension must not spawn Grok. Child env forces `GROK_DISABLE_AUTOUPDATER=1`. Lent tools use MCP-over-ACP on that pipe (`x.ai/mcp/sdk`, `x.ai/mcp/servers`, `_x.ai/mcp/sdk_call`).

## Architecture

| File | Role |
| --- | --- |
| `src/model.ts` | Extension entry: provider registration, renderers, `/grok` command, media display, steer wiring |
| `src/model/provider.ts` | Pi transcript to ACP prompt. System prompt goes as `_meta.rules`. Only the new tail is sent. Model IDs. |
| `src/model/connection.ts` | One stdio leash per Pi process, ready handshake, heartbeat and dialog extensions, leash events, `session/new` or `session/load`, `cached_token` auth |
| `src/model/session.ts` | ACP updates to Pi events, client hooks, media copy, lent-tool parking. `startPrompt` owns the prompt lifetime for normal turns and `/grok` commands: busy state, cancel, late-completion suppression |
| `src/model/hooks.ts` | `capabilityGate`, `postEditContext`, `stopGate` |
| `src/model/permissions.ts`, `questions.ts` | Grok permission prompts and `ask_user_question` as Pi dialogs |
| `src/model/steer.ts` | Mid-turn Enter to `_x.ai/interject` |
| `src/config.ts` | `~/.pi/agent/grok-ws.json`, environment overrides, leash stall/request/dialog deadline validation |
| `src/login.ts` | `/grok login`: runs `grok login --device-auth`, parses the URL and code. Grok stores the credential; Pi stores nothing. A signed-out Grok offers no `cached_token` method, and `connection.ts` then drops the connection with a pointer to `/grok login` |


Invariants:

- Grok native tool calls stay on Grok. They become `grok-tools` batch rows or `grok-tool` entries, never thinking text or Pi tool calls (`test/model.test.ts`). Rows keep call order (`test/extension.test.ts`).
- Custom entries and `grok-media` messages are display only. The provider never sends them to Grok.
- Grok's model context keeps full tool results. Pi's copies are shortened: 8000 characters in a `grok-tool` entry, 600 in the expanded renderer. Native tool activity stays out of the thinking stream.
- The stdio child starts Grok in default permission mode. Never pass `--always-approve`. The leash kills Grok's process group when Pi stops heartbeating and denies unanswered tracked requests before Grok's hook timeout; `PI_GROK_LEASH=none` explicitly opts out.
- `zod` stays in `dependencies` although nothing imports it: `@agentclientprotocol/sdk` lists it as a peer, Pi installs with `--legacy-peer-deps`, and the extension failed with `Cannot find module 'zod/v4'` without it (`docs/launch-verification.md`, G2).

## Documentation claims

Every capability claim in `README.md` or `docs/` must point to source, a unit test, or a probe result that exists. Mark a claim as unverified when its evidence file is absent. Record the Grok, Pi, and Node versions with each live result. Tracked files use repository-relative or `~/` paths only.

The license is Apache-2.0 (`LICENSE`, `license` in `package.json`). Published on npm as `pi-grok-agent` (0.1.0 on 2026-09-28). `.github/workflows/ci.yml` runs `npm run check` and `npm test` on Node 22, 24, and 26 for every push to `main` and every pull request. To release: bump `version` in `package.json`, push, then publish a GitHub Release tagged `v<version>`. `.github/workflows/release.yml` checks the tag against `package.json`, runs the checks, publishes to npm through trusted publishing (no npm token, with provenance), and attaches the same tarball to the release. Manual `npm publish` still works and needs the owner's npm login and security key. Check `npm pack --dry-run` before a release: the `files` list decides the tarball.
