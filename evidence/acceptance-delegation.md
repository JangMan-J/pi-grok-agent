# Acceptance ledger

Target: Pi delegates to a shared Grok leader through a WebSocket ACP gateway.
Grok retains its agent loop, tools, sessions, and native permission policy.
Anvil and stdio-to-ws are references only.

## Checks

| Requirement | Evidence | Result |
| --- | --- | --- |
| WebSocket ACP handshake and bearer authentication | `leader-live-probe.json`, `test/client.test.ts`, active gateway rejected an invalid bearer token with HTTP 401 | Passed |
| Independent leader clients receive their own session updates | `leader-probe.json`, `leader-websocket-probe.json` | Passed |
| Reconnected client does not take over another client's session updates | `leader-websocket-probe.json` | Passed |
| Grok executes its own file tool | `leader-live-probe.json`: native `read_file` returned an undisclosed random token | Passed |
| No Pi filesystem or terminal service advertised | `test/client.test.ts`: exact initialize capabilities | Passed |
| Context survives follow-up and a new socket | `leader-live-probe.json` | Passed |
| Cancellation reaches the native agent | `leader-live-probe.json`: cancellation after streaming began | Passed |
| Abort, timeout, and concurrent-prompt handling | `test/client.test.ts` | Passed |
| Reconnect does not replay a prompt | `test/client.test.ts`: active remote prompt blocks a new one | Passed |
| Replay notifications reach a recovery consumer before load completes | `test/client.test.ts` | Passed |
| Session teardown cancels a delayed handshake | `test/pending-connection.test.ts` | Passed |
| Permission selection/rejection maps to ACP options | `test/extension.test.ts`, mock WebSocket requests | Passed |
| Native permission approval and denial | `live-probe.json`, explicit ask policy in a trusted synthetic workspace | Passed |
| Real Pi loader registers the command and tool | `test/extension.test.ts`, Pi 0.87.1 | Passed |
| Installed extension works with the user's extension set | `pi-smoke.json`: direct task, native read/write, recovered output, separate Pi sessions, no Pi inference | Passed |
| TypeScript | `npm run check` | Passed |
| Unit/integration fixtures | `npm test` | 11 passed |
| Documentation | simple-english descriptive lint | Passed |

## Review corrections

The independent review used `openai-codex/gpt-6-astra` in this package directory, before Git initialization.
The saved review is `client-review.md`. No reviewer modified source.

- Pending handshakes survived Pi session changes. Owned abort controllers and a session generation now prevent stale attachment and persistence.
- Session load discarded replay notifications. The client now sets session identity and a recovery consumer before the load request.
- Recovery uses a replacement widget and a separate private transcript. It does not append replayed history as a fresh task answer.

Both original review failures have regression checks. The repository now uses branch `main` with no commit.

## Permission-probe correction

The first Pi smoke probe assumed default-mode native edits always require an ACP permission request.
That assumption failed: the native `write` tool created the synthetic file without a dialog.
Adding `_meta.yoloMode: false` did not change that behavior.

Observed local settings: Grok uses an always-approve default, and Claude-compatible settings use `bypassPermissions`.
First-party `permission/resolution.rs` converts the latter into a catch-all allow rule, independently of the yolo flag.
The native permission manager can therefore allow the write before any client permission request.
A project fixture also failed to change the result. `grok inspect --json` showed only the global Claude permission source.

The corrected smoke probe distinguishes both legitimate native outcomes: a requested dialog that Pi rejects, or a write allowed by Grok policy.
It does not claim that the original native write now requires approval.
The deciding rerun used a separate trusted synthetic workspace with an explicit project default/ask policy.
Native denial prevented the file write. Native one-time approval created the expected file. Both checks passed in `live-probe.json`.
The normal user-policy smoke test still correctly records no live dialog. These are different configuration conditions.
No global permission mode or allow-rule settings changed. The probe granted trust only to its own disposable workspace.
The client still sends `yoloMode: false` for new and loaded sessions.
The first failed acceptance assumption is preserved in `pi-smoke-permission-failure.json`.

## Leader correction

The user required `grok agent leader` as the shared backend.
Standalone `serve` accepted two clients, but sent session A's update to client B. The RPC response still reached A.
That original behavior remains recorded in `multiclient-probe.json`.
The native leader sent the same update to A, without sending it to B. Both clients remained usable.
The gateway preserves this routing with one native `grok agent --leader stdio` process per WebSocket connection.
The source trace is `leader-websocket-route.md`, against first-party commit `f0e3be1100ef5252488e3be8bb0e91cf68d8c305`.
No upstream source or Fabric provider was changed.

The active launcher now runs `grok agent leader` with a dedicated socket and `--no-exit-on-disconnect`.
Its WebSocket listener remains on `127.0.0.1:2419`. The existing default leader socket was not changed.
The installed Pi RPC probe passed again against this leader gateway, under the current HOME and extension set.
The trusted permission-denial fixture was not repeated against the leader. Its earlier result applies to standalone `serve`.
The current native-policy write and mock permission-dialog checks passed.

`npm run check` passed. The LSP probe did not report TypeScript diagnostics, but did not confirm clean coverage for every file.
Auxiliary rules flagged strict fixture JSON parsing, startup URL parsing, and fixture formatting choices. These are not runtime failures.
The startup parser intentionally fails on invalid settings. The probes intentionally require valid JSON-RPC frames.

## Scope and limits

- The live direct and leader probes used Grok Build 1.0.41 and model `grok-4.7`.
- Independent sessions share the leader. Clients that subscribe to the same session share its notifications.
- A session actor can leave memory after its last subscriber disconnects. Saved history and in-flight execution have different lifetimes.
- No automatic retry of an interrupted prompt.
- An unacknowledged cancellation reports uncertain remote work rather than claiming that work stopped.
- No client-side sandbox or tool replacement. The native working directory is not a filesystem boundary.
- The existing Pi TUI needs `/reload` to discover the installed extension. RPC verifies the UI protocol, not a visual terminal interaction.
- A live loopback server was launched separately from Pi. There is no boot-time service or Fabric modification.
