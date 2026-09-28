# Native Grok WebSocket ACP review

## Scope and provenance

Reviewed only `src/client.ts`, `src/index.ts`, and `src/config.ts` in `/home/jangpi/JangLabs/pi-grok-agent`.

Contract: `/tmp/pi-grok-acp-review/websocket-protocol.md`, read in full.

Actual reviewer model: `openai-codex/gpt-6-astra`, thinking level `high`.
Evidence: session `01a0e4ba-3018-76a1-b0c8-fa19820bd3b1`, header and model-change records in the Pi session directory.
The session header and `pwd` both identify `/home/jangpi/JangLabs/pi-grok-agent`.
Branch and commit: unavailable. Both Git queries returned `git: target is not a repository`.

No source files changed. No Grok process, inference request, Anvil runtime, or stdio bridge started.
Behavioral probes used Node `v26.10.0`, the installed dependencies, and a temporary loopback WebSocket server with fixed ACP responses.
Pi lifecycle probes used a mock extension API and awaited the registered lifecycle handlers. They did not launch an interactive Pi session.

The main worker changed lifecycle code during this review. I reread that code and reran both findings against the updated files.
Final tested SHA-256 values:

```text
src/client.ts cf359a76a8fe6284190be5844a0cad8b706ba6147135ff2afca74091fba632a4
src/index.ts  f29dd1c812f159872d35306896f723372f03f8c923c6fc6166473d8ebebd6699
src/config.ts 0d20c01f7595d355496cb851fd949e88c7d3f2d864da773dda0bf607e258540e
```

## P1: Pending connection survives session teardown and attaches the wrong Grok session

Primary location: `src/client.ts:90–95`, especially `this.socket = await openSocket(options, signal)`.
Related locations: `src/index.ts:43–54`, `61`, `122–124`, and `139–146`.

During the WebSocket handshake, the socket exists only inside `openSocket`. Neither `close()` nor `disconnect()` can reach it.
The explicit `connect` and `new` commands pass no abort signal. They also create no `commandController`.
Consequently, session shutdown and restoration can finish while the old connection operation remains pending.

After the handshake completes, the old operation assigns the socket, creates the Grok session, and appends its saved state.
There is no session-generation check before these writes. The next `run()` checks only `grok.connected`, so it reuses that stale session.
This crosses Pi session boundaries and can give a new conversation the previous conversation's Grok context.
The same pending connection also survives `/grok-ws disconnect`. `/grok-ws cancel` has no connection controller to abort.

### Lifecycle reproduction

1. Delay the fake server's WebSocket upgrade callback.
2. Start `/grok-ws connect` in Pi session `pi-A`.
3. Await the registered `session_shutdown` handler.
4. Change the mock session ID to `pi-B` and await `session_start`.
5. Release the upgrade callback and await the original command.
6. Submit `task from pi-B`.

The probe observed:

```json
{
  "appendedEntry": {
    "currentOwner": "pi-B",
    "data": {"owner": "pi-A", "sessionId": "from-pi-A"}
  },
  "requests": [
    {"method": "initialize"},
    {"method": "session/new"},
    {"method": "session/prompt", "sessionId": "from-pi-A", "prompt": [{"type": "text", "text": "task from pi-B"}]}
  ]
}
```

Suggested correction: give the entire connection operation an owned abort controller, including configuration reads and socket establishment.
Abort it on cancellation, disconnection, and session changes. Check the operation generation before connection assignment, persistence, or result delivery.

Acceptance check: delay upgrade, complete shutdown/start or tree navigation, then release upgrade.
The obsolete operation must not persist a session or become the active connection. A new-session task must create or load that session's own Grok session.

## P2: Reconnect discards the history needed to recover interrupted output

Primary location: `src/client.ts:121–123`.
Related locations: `src/client.ts:96–97` and `src/index.ts:59–79`.

The contract requires processing history notifications before the `session/load` response.
However, `connect()` clears `this.sessionId` and restores it only after that response.
The notification handler therefore rejects every history notification that arrives during load.

There is a second gap: the extension installs its output callback only for `prompt()`, after connection completes.
Thus, moving the session-ID assignment alone will not restore output through the public API.
Connected sessions with an inherited running prompt also have no output consumer until a new local prompt starts.

After a transport failure, Grok can finish work while Pi is disconnected. On reconnect, the adapter silently discards Grok's recovered answer and tool history.
The saved session survives, but the user cannot retrieve that result through this integration without another model request.
No automatic prompt replay occurs, which is correct. History recovery must not require prompt replay either.

### History-recovery reproduction

A fake server sent an `agent_message_chunk` notification with `_meta.isReplay: true` before its `session/load` response.
The probe installed an observation callback directly on the client to isolate the session-ID filter from the missing public callback.
The result was:

```json
{"serverSentHistory":true,"appliedUpdates":0,"loadedSession":"from-pi-A"}
```

Suggested correction: establish session identity and a recovery output consumer before sending `session/load`.
Keep recovered history separate from a new prompt's answer. Handle full-replay replacement before adding cursor support.

Acceptance check: disconnect after prompt submission, complete the fake task remotely, and reconnect.
Recover the answer from load notifications without sending another `session/prompt`. Also verify full replay does not duplicate displayed history.

## Other reviewed behavior

- The source uses the SDK's modern `client().connect(stream)` path and native WebSocket framing.
- No Anvil runtime or client filesystem/terminal implementation appears in the reviewed files.
- Reconnect does not automatically resend a prompt. An inherited running prompt blocks another local prompt.
- Permission selection maps the selected label back to the offered `optionId`. Missing UI and aborted selection return `cancelled`.
- Local prompt cancellation sends `session/cancel`, aborts the permission controller, and has a ten-second forced-close fallback.
- No additional concrete correctness issue was established in `config.ts`.

The other reviewed behaviors are source observations, not live Grok interoperability results. Both reported defects have local fake-server reproductions.
