# pi-grok-agent: agent notes

This package is a Pi extension. It registers the model provider `grok`. Grok Build runs its own harness and tools. Pi drives turns, shows the stream, answers Grok's dialogs, gates Grok's tools through client hooks, and can lend Pi tools over MCP.

Human setup and the settings reference are in `README.md`. Design notes are in `docs/first-class-model.md`. Launch copy and gates are in `docs/launch.md`. Runtime check results are in `docs/launch-verification.md`.

## Commands

Scripts are in `package.json`. Run `npm install` once before any check. The `pi` manifest loads `./src/model.ts`.

- `npm run build:leash`: build the Rust crate and copy the release executable to ignored `bin/pi-grok-leash`. Requires Rust stable (verified with rustc 1.99.0); no `rust-toolchain.toml` is present.
- `npm run check`: type check (`tsc --noEmit`).
- `npm test`: unit tests plus fake-child transport and leash integration. With the built binary on Linux, `test/leash-process.test.ts` exercises Pi SIGKILL, Pi SIGSTOP with a hook pending/while idle, and simulated suspend (~30 s). Nothing contacts Grok.
- `npm run test:leash-real`: run `test/leash.test.ts` with the Rust `bin/pi-grok-leash` and fake Grok; skips when the binary is absent.
- `cargo test` in `leash/`: Rust unit and process tests with a fake child.
- `npm pack --dry-run`: the `files` list in `package.json` decides the tarball. Keep `evidence/`, `test/`, and the probe scripts out of it.
- Live probes use the current Grok login and spend usage: run only when the user asks. `scripts/model-probe.ts` and `scripts/reconnect-probe.ts` passed on `7c26faa` (Grok 1.0.46, Pi 1.0.2, Node 26.10); see `docs/launch-verification.md`. Obsolete gateway probes exit 2. `npm run test:live` runs the two adapted probes. Results go to ignored `evidence/`; keep the tracked demo video until a release points elsewhere.

## Child ownership

`src/model/connection.ts` starts one non-detached `pi-grok-leash` per Pi process; `leash/src/runtime.rs` spawns `grok --permission-mode default agent --no-leader stdio` in a new process group. No leader, daemon, fixed ACP port, or secret file. `drop()` and `close()` close the leash's stdin so it kills and reaps Grok's group, with signal escalation if the leash does not exit. Linux parent-death signals protect leash and immediate Grok on abrupt Pi death, but do not themselves kill Grok's whole group. `PI_GROK_BINARY` and `PI_CODING_AGENT_DIR` are inherited at spawn time. Loading the extension must not spawn Grok. Child env forces `GROK_DISABLE_AUTOUPDATER=1`. Lent tools use MCP-over-ACP on that pipe (`x.ai/mcp/sdk`, `x.ai/mcp/servers`, `_x.ai/mcp/sdk_call`).

## Architecture

| File | Role |
| --- | --- |
| `src/model.ts` | Extension entry: provider registration, renderers, `/grok` command, media display, steer wiring |
| `src/model/provider.ts` | Pi transcript to ACP prompt. System prompt goes as `_meta.rules`. Only the new tail is sent. Model IDs. |
| `src/model/connection.ts` | One stdio leash per Pi process, ready handshake, heartbeat/dialog extensions, leash events, `session/new` or `session/load`, `cached_token` auth. `guardedRequest` retains Pi-to-Grok request deadlines (`test/hardening.test.ts`); old `guard.ts` is removed. |
| `leash/` → `bin/pi-grok-leash` | Rust stable crate and built executable. `runtime.rs` owns process lifetime/forwarding; `tracker.rs` owns the three tracked reverse-request deadlines, synthetic deny/cancel, late-reply drops, and suspend re-baselining. |
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
- The extension never spawns the Grok agent directly except under `PI_GROK_LEASH=none` (the separate `/grok login` flow still invokes the CLI). The child uses default permission mode. Never pass `--always-approve`.
- The leash kills Grok's process group when Pi stops heartbeating and denies/cancels unanswered tracked requests; it never grants permission. A deadline shows one notice and keeps the child/turn running (`d4e5891`, `test/leash.test.ts`); a stall ends the turn. `PI_GROK_LEASH=none` explicitly opts out and debug says `UNGUARDED`. Short stalls, escaped descendants, abrupt parent-death group limits, and suspend behavior are documented in `docs/first-class-model.md`. Live Grok-with-leash probes have not been run.
- `zod` stays in `dependencies` although nothing imports it: `@agentclientprotocol/sdk` lists it as a peer, Pi installs with `--legacy-peer-deps`, and the extension failed with `Cannot find module 'zod/v4'` without it (`docs/launch-verification.md`, G2).

## Documentation claims

Every capability claim in `README.md` or `docs/` must point to source, a unit test, or a probe result that exists. Mark a claim as unverified when its evidence file is absent. Record the Grok, Pi, and Node versions with each live result. Tracked files use repository-relative or `~/` paths only.

The license is Apache-2.0 (`LICENSE`, `license` in `package.json`). Published on npm as `pi-grok-agent` (0.1.0 on 2026-09-28). `.github/workflows/ci.yml` keeps `npm run check` and `npm test` on Node 22, 24, and 26 for every push to `main` and every pull request. Its Linux leash job installs Rust stable, caches Cargo, runs `cargo test`, `npm install` (no tracked npm lockfile), `npm run build:leash`, `npm run check`, `npm test`, and `npm run test:leash-real`. To release: `npm run release patch` (or `minor`, `major`, or an exact version). That runs check and tests, bumps `version`, commits, tags `v<version>`, and pushes with tags. The tag push runs `.github/workflows/release.yml`: it checks the tag against `package.json`, installs Rust stable and builds the linux-x64 leash before checks/packing, publishes to npm through trusted publishing (no npm token, with provenance), then creates the GitHub Release with generated notes and the same tarball attached. Only linux-x64 is shipped; other Unix platforms build from the repository and remain unverified (Windows is unsupported by the Unix crate). The `files` field includes `bin` but excludes `leash/`, tests, evidence, and scripts; keep `bin/` and `leash/target/` gitignored. Manual `npm publish` still works and needs the owner's npm login and security key. Check `npm pack --dry-run` before a release: the `files` list decides the tarball.
