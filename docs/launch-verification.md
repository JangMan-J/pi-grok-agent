# Launch verification

Live results for gate G4 in [launch.md](launch.md). Record each run here, not in `launch.md`. Raw results are in `evidence/` (sanitized: home paths as `~/`, scratch directories as `/tmp/<scratch>`, session and call IDs replaced).

## Run 2026-09-28

Versions: Node.js 26.10.0, Pi 0.87.1, Grok Build 1.0.41 (stable). Linux workstation. Model `grok/grok-4.7`.

Conditions: isolated gateway (`PI_GROK_LEADER_SOCKET`, `GROK_ACP_URL` on port 2429, `PI_CODING_AGENT_DIR` with a settings file that lists only this extension, `GROK_AGENT_SECRET` in both processes), started with `node scripts/server.ts` from the checkout at `0d29207` plus the uncommitted `evidence/` directory. The production gateway on 2419 was running and untouched throughout. Eight probes ran in sequence over 3 minutes 36 seconds; every one exited 0. `scripts/reconnect-probe.ts` was not run (not isolatable, see [usage.md](usage.md#live-probes)).

| Command | Outcome | Evidence |
| --- | --- | --- |
| `scripts/model-live.sh gateway` | Pass. `pi -p --model grok/grok-4.7` returned the token and `done.txt` was written. Pi executed 0 tools; Grok's harness ran `run_terminal_command` ×5 (default policy `extensions`, `headlessPermissions=allow`). | `evidence/model-live-gateway-extensions.json` |
| `scripts/hooks-live.sh` | Pass, 3/3. Gate: read-only Pi session, `hashline_edit` failed and `settings.py` unchanged. Post-edit: broken edit repaired in the same turn (two `hashline_edit` completed, file valid). Stop: turn held until `done.txt` existed; Grok created it with `run_terminal_command`. | `evidence/hooks-live.json` |
| `node scripts/model-probe.ts` | Pass. Grok listed Pi-hosted tools through `x.ai/mcp/sdk_call`, called the Pi-only `pi_echo_secret`, waited 5014 ms for the held result, and the final answer contained the token only that tool could return. | `evidence/model-probe.json` |
| `node scripts/gateway-guard-probe.ts` | Pass, 3/3 at `ackMs=5000`. Hung Pi (no ack): gateway denied `write` after 5008 ms, file not created. Gone Pi (socket dropped at the permission prompt): file not created. Dialog: acked `dialog:true`, human answer `allow` after 8000 ms was used, file created. | `evidence/gateway-guard-probe.json` |
| `node scripts/mcp-gate-probe.ts` | Pass. Read-only session: `marked__peek` allowed and reached its server (`MARBLE`); `unmarked__poke` denied with the read-only reason; Grok reported the denial verbatim. | `evidence/mcp-gate-probe.json` |
| `node scripts/question-probe.ts` | Pass. `ask_user_question` round trip (`mode: default`) and the `/grok` command paths. | `evidence/question-probe.json` |
| `node scripts/image-probe.ts` | Pass. `image_gen` returned `{type: "ImageGen", path, filename: "1.jpg", session_folder: "images"}`; the file is under `~/.grok/sessions/<encoded cwd>/<session-id>/images/`, and the answer quoted the same path. | `evidence/image-probe.json` |
| `node scripts/hooks-probe.ts` | Pass. Raw ACP frames: `pre_tool_use` for `run_terminal_command` (denied by the Pi hook) and `hashline_read` (continue); `post_tool_use` carried the read result and `additionalContext` was injected; Grok fell back to a file tool and returned the token with the injected marker. | `evidence/hooks-probe.json` |

Not covered by this run:

- Mid-turn steering effect on a running turn (`scripts/queue-probe.ts interject`, standard output only). G5 stays a demo gate.
- Reconnect across a gateway or leader restart (`scripts/reconnect-probe.ts`).
- Image-edit and video result types (`image-probe.ts` covers `image_gen` only).
- Other Node.js and Pi versions, other platforms.

## Install paths and first run, 2026-09-28

Same versions. Each run used a new `HOME` under `/tmp` that held only a copy of the Grok login (`~/.grok/auth.json`, `agent_id`, `config.toml`), and `PI_CODING_AGENT_DIR` inside it. The runs used the default port 2419; no other gateway was running. Each ended with Ctrl+C on the gateway, and its leader stopped with it.

| Gate | Command sequence | Outcome |
| --- | --- | --- |
| G2, clone | `git clone` (GitHub, `0fd1524`), `npm install --omit=dev`, `npm run server`, `pi -e . --model grok/grok-4.7 -p`, `pi install .`, a tool turn, an interactive turn, `pi remove .` | Pass. Headless turn answered `PONG`. Tool turn on the storyboard's `sum.mjs`: Grok changed the loop start from `1` to `0` and `node --test` passed. Interactive turn answered `PONG`. |
| G2, git | `pi install git:github.com/JangMan-J/pi-grok-agent`, headless and interactive turns without `-e`, then a gateway started from the git checkout (`node <checkout>/scripts/server.ts`) | Pass, `PONG` on each turn. |
| G2, npm | Packed tarball of the working tree after `0fd1524` (`files` list, compiled gateway, `zod` dependency) published to a local Verdaccio registry, `private` removed in a temporary copy only. Then `npm i -g pi-grok-agent`, `pi-grok-gateway` from `~`, `pi install npm:pi-grok-agent`, headless turn, tool turn, interactive turn, `pi remove npm:pi-grok-agent` | Pass. `PONG`; the `sum.mjs` fix with `node --test` 1 pass, 0 fail; interactive `PONG`. The public npm registry was not used: this checks the package layout, not publication. |
| G2, npm, one command | Same local-registry method with gateway auto-start (after `8dac327`). Only `pi install npm:pi-grok-agent`; no global install, nothing on 2419, no `pi-grok-gateway` on `PATH`. Then two headless turns, a tool turn, an interactive turn with `/grok debug`, then the gateway stopped and a turn with `PI_GROK_AUTOSTART=0` | Pass. First turn `PONG` in 5.2 s including the gateway start; the gateway ran detached (parent: the user systemd manager, own session) and created the secret 0600. Second turn `PONG` in 2.9 s on the same gateway, one gateway running. `sum.mjs` fixed, 1 pass. `/grok debug`: `connected; auto-start on`. SIGINT stopped the gateway and its leader. With auto-start off and no gateway: `Grok WebSocket handshake failed`, and no gateway started. |
| G2, public npm | `pi-grok-agent@0.1.0` from `registry.npmjs.org` (shasum `cf5388e1…`, the tarball packed from `821bd0b`). Only `pi install npm:pi-grok-agent`; nothing on 2419 | Pass. First turn `PONG` in 2.9 s including the gateway start (`dist/scripts/server.js` from the installed package). `sum.mjs` fixed, `node --test` 1 pass. Interactive turn `PONG`. SIGINT stopped the gateway and its leader. |
| Auto-start, clone | `pi -e <clone>` in a new `HOME`, nothing on 2419 | Pass. `PONG`; the extension started `scripts/server.ts` from the clone. `pkill -INT -f 'pi-grok-agent/(dist/)?scripts/server'` stopped it and its leader. |
| G3, before | Agent directory with this extension and no `grok-ws.secret`, no gateway | Pi 0.87.1 exited with status 1 for every model and mode: `Failed to load extension ".../src/model.ts": ... ENOENT ... grok-ws.secret`, then `Hint: Start without extensions using "pi -ne"`. Pi exits on any extension load error. |
| G3, after | Same, with the secret read at connect time | The TUI starts with `grok-4.7` selected. A Grok turn prints `Grok gateway secret not found at <file>. Start the gateway once (pi-grok-gateway, or npm run server in the clone); it creates the file. Then send the message again.` `test/gateway.test.ts` covers the reconnect after the file appears. |

Sign-in, 2026-09-28 (Grok Build 1.0.41, scratch `HOME`, one disposable login approved by the owner and signed out afterwards):

- A signed-out Grok offers one ACP auth method, `grok.com`. With Pi's stored xAI OAuth token in `XAI_API_KEY`, `session/new` still fails with `Authentication required`. Pi's `/login` xAI entry and `grok login` use the same OAuth client (`b1a00492-...` on `https://auth.x.ai`), but Grok Build accepts only its own stored login for agent sessions.
- A gateway that is already running picks up a login made while it runs: before, the connection failed with `Grok Build is not signed in. Run /grok login, ...`; after the credential file appeared, the next open authenticated and `session/new` succeeded, with no gateway or leader restart.
- x.ai rotates refresh tokens and keeps the previous one valid: a refresh returned a new token, a second refresh with the old token succeeded, and the new token still worked afterwards.

Free Grok account, 2026-09-28 (the owner's own login, Grok Build 1.0.41):

- Grok Build works on a free account: `grok models` lists `grok-4.7` only, and headless turns through `pi-grok-agent` returned `PONG`, and a read-only tool turn answered correctly.
- Found: `pi-grok-agent` 0.1.0 never sends the model picked in Pi to Grok. Turns for `grok-4.7-build-fast`, `grok-4.6`, and `grok-4.5` all answered, but Grok's session records show `current_model_id: grok-4.7` for every one. Fixed after 0.1.0: Pi sets Grok's `model` config option, and a model the account lacks fails with `grok-4.6 is not available on this Grok account. Available: grok-4.7. Pick one of those in /models.` Checked live on the same account.

Found on the packed layout and fixed before the npm run: the gateway `bin` failed under `node_modules` with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, and the extension failed with `Cannot find module 'zod/v4'`, because `@agentclientprotocol/sdk` declares `zod` as a peer and Pi installs with `--legacy-peer-deps`.

Node.js 22.19 is Pi's minimum. It is not a tested version of this package. Do not write "Pi 0.87+".
