# Launch plan: pi-grok-agent 0.1

Status: draft. This branch replaces the transport with stdio-direct. Historical launch results below are not live evidence for this branch; fresh probes are pending. The GitHub About text, topics, and social preview from section 5.1 were applied and verified on 2026-09-28. Every other external action in this file (tag, release, posts, list PRs, npm) is future work that needs the owner's authorization. No code is pushed and nothing is announced.

This file holds the capability ledger, launch gates, channel drafts, schedule, release notes, and metric plan. Setup and troubleshooting live in [`README.md`](../README.md). The demo storyboard lives in [`docs/demo.md`](demo.md). Runtime checks and their results live in [`docs/launch-verification.md`](launch-verification.md). The goal is a successful first use and useful feedback, not reach.

## 1. Status facts

- License: Apache-2.0, chosen by the owner. Main adds `LICENSE` and the `license` field in `package.json`.
- GitHub: `JangMan-J/pi-grok-agent` is already public.
- npm: `pi-grok-agent@0.1.0` published 2026-09-28 by `jangmanj`, from `821bd0b`. The Pi package gallery lists npm packages.
- Pi repository: the installed Pi 0.87.1 `package.json` names `github.com/earendil-works/pi` (the research digests cite `pi0/pi-mono` and `badlogic/pi-mono`, which are wrong).
- Install path: `pi install npm:pi-grok-agent` for published releases; this prototype can be loaded from its clone with `pi -e .`. The first turn starts one `--no-leader stdio` child (`src/model/connection.ts`). Historical install results in [launch-verification.md](launch-verification.md) predate this transport.
- Pi compatibility: tested with Pi 0.87.1 only. Other Pi versions are untested. Node.js 22.19 is Pi's minimum. This package is tested only on Node.js 26.10.0. Do not write "Pi 0.87+".
- GitHub About, applied 2026-09-28: the description and topics from [docs/github-presentation.md](github-presentation.md) are live, and [docs/assets/old/social-preview.png](assets/old/social-preview.png) was the social preview (the served image matched the committed PNG by SHA-256). Its replacement, [docs/assets/social-1280x640.png](assets/social-1280x640.png), was uploaded and verified the same way on 2026-09-30. Details in section 5.1.

Positioning, without "first" or "only" claims: Grok Build already offers ACP (`grok agent serve` and a stdio mode), so other ACP clients can drive it. This project makes Grok Build a Pi model provider. Grok keeps its own harness, tools, and history. Pi supplies the transcript, gates, lent tools, and dialogs. Use real captures, not mockups.

## 2. Capability ledger

Evidence labels:

- Source: the cited code shows the behavior.
- Unit: a tracked test in `test/` covers the behavior with mocks. It does not contact Grok.
- Live 2026-09-28: a result from the run recorded in [`docs/launch-verification.md`](launch-verification.md), with its `evidence/` file.
- Live, evidence absent: `README.md` or `docs/first-class-model.md` reports a live run, but no result file is in this checkout. Do not make a public claim until [`docs/launch-verification.md`](launch-verification.md) records a result.
- Unprobed: the code handles the case, but no probe or test exercises it.

Tracked tests versus current baseline: the tracked suite is 33 test cases in five files under `test/`, plus 17 probe scripts under `scripts/`. On base `3b77798`, Main ran `npm run check` (tsc) and `npm test`, and all 33 tests passed. That baseline is mock-only. It says nothing about live Grok behavior.

| Capability | Status | Evidence |
| --- | --- | --- |
| `grok/grok-4.7`, `grok-4.7-build-fast`, `grok-4.6`, `grok-4.5` as Pi models, context window from Grok Build's model cache (256,000 when absent) | Source, Unit | `src/model.ts` `registerProvider` and `grokContextWindows`, `MODEL_IDS` in `src/model/provider.ts`, `test/extension.test.ts` "context windows come from Grok Build's model cache" |
| Grok native tools run on Grok's harness. Pi shows them as `grok-tools` batches and `grok-tool` entries and does not execute them. | Unit. Live 2026-09-28 (0 Pi tool executions, 5 Grok native). | `session.ts` `tool_call` case, `test/model.test.ts` "Grok native tool activity is observed, not executed", `scripts/model-live.sh` |
| Hashline edits (`hashline_read`, `hashline_edit`, `hashline_grep`) | Conditional | Only when `~/.grok/config.toml` sets `[toolset] file_toolset = "hashline"`. Otherwise Grok uses `read_file` and `search_replace`. |
| Full tool results | Qualified | Grok's model context keeps full results. Pi adds only `additionalContext` in `post_tool_use`. Pi's copies are shortened: 8000 in the `grok-tool` entry, 600 in the expanded renderer. Lent Pi tool results pass to Grok whole. |
| Pi tools lent over in-process HTTP MCP; temporary SDK comparison switch | Unit; live stdio-direct probe pending | `src/model/mcp-server.ts`, `src/model/connection.ts`, `test/transport.test.ts`, `scripts/model-probe.ts` |
| Grok permission prompts as Pi dialogs, headless policy, and `/grok perms yolo` selecting allow once | Unit | `src/model/permissions.ts`, `test/permissions.test.ts`, `headlessPermissions` in `src/config.ts` |
| Pi gates Grok tools (`pre_tool_use`), post-edit check, stop check | Unit. Live 2026-09-28 (`hooks-live` 3/3, `hooks-probe`). | `test/hooks.test.ts`, `scripts/hooks-live.sh` |
| `/grok perms yolo, auto, ask, read-only` | Unit | `test/hooks.test.ts` "/grok perms" tests; `test/permissions.test.ts` for allow once on `session/request_permission` |
| Close-time reverse-request guard; one answer and late suppression, no timers | Fake-child tests; hung Pi unguarded | `src/model/guard.ts`, `test/transport.test.ts` |
| `ask_user_question` as Pi dialogs | Unit. Live 2026-09-28 (`question-probe`). | `test/questions.test.ts` |
| Image generation: copied to `.pi/grok-images/`, shown inline after the turn | Unit. Live 2026-09-28 (`image-probe`: `image_gen` result shape and path; the inline display step is not covered by the probe). | `copyMedia`, `flushMedia`, `test/hooks.test.ts` "media copy", `scripts/image-probe.ts` (probes `image_gen` only) |
| Inline image display | Conditional | The terminal must support images. Every non-PNG preview (JPEG, WebP, GIF) needs ImageMagick `magick` for the PNG conversion (`asPng` in `src/model.ts`). Without it, only the path shows. |
| Image edit, image to video, video generation | Unprobed | Detected by result type in `mediaPath`. Video files get a path line only, because `IMAGE_MIME` has no video types. |
| Images attached in Pi reach Grok | Unit | Written to a temp file and passed by path. `test/hooks.test.ts` "inbound image blocks" |
| Mid-turn Enter steers into Grok's running turn (`_x.ai/interject`), Alt+Enter queues a follow-up | Unit only. Live effect, evidence absent. | `src/model/steer.ts`, `test/steer.test.ts`, `test/extension.test.ts` (the registered handler ignores steers while another model is active). `docs/first-class-model.md` has two live notes that do not agree. |
| `/grok goal` and `/grok compact` share the normal prompt lifetime; a timeout cancels on Grok and frees the session | Unit | `test/model.test.ts` "/grok command" tests |
| Load a stored session after Pi restart | Source; live check pending | `src/model/connection.ts`, `scripts/reconnect-probe.ts` |
| Usage and cost from Grok's own report | Unit | `test/model.test.ts` "usage" tests |

Known compatibility gap: the stream does not call `options.onPayload` or `options.onResponse` from Pi's custom-provider contract.

## 3. Safety facts

Prerequisites are in [`README.md`](../README.md). Tested versions go with each result in [`docs/launch-verification.md`](launch-verification.md).

Facts for the README and every post:

- Pi packages run with the user's permissions (Pi `docs/packages.md`).
- Grok runs as the operating-system user. Its session directory is not a sandbox.
- ACP uses stdio pipes to one non-detached agent child. Default HTTP MCP binds to ephemeral IPv4 loopback (`src/model/connection.ts`, `src/model/mcp-server.ts`).
- The child uses default permission mode, never `--always-approve`, and forces `GROK_DISABLE_AUTOUPDATER=1`.
- Grok usage counts against the user's Grok account.

Three separate permission layers. Do not merge them in copy:

- `/grok perms` is Pi's gate on Grok's native tools at `pre_tool_use`. `auto` mirrors Pi's tool set. `ask` adds a Pi dialog for each write or shell call. `read-only` denies writes and shell. `yolo` treats the session as having read, edit, write, and bash, skips Pi's confirm dialog, and answers `session/request_permission` with allow once (`permissionMode` in `src/model/session.ts`, `permissionAnswer` in `src/model/permissions.ts`).
- Deny and allow overrides (`denyGrokTools`, `allowGrokTools`, `PI_GROK_DENY_TOOLS`) are checked first in `capabilityGate` (`src/model/hooks.ts`). An explicit deny wins over an allow entry, and both win over the mirror.
- Grok's own permission prompts are a different path. `grokMode` (`default`, `auto`, `yolo`) sets Grok's session mode (`yoloMode` and `autoMode` in `_meta`, `src/model/connection.ts`). `auto` and `yolo` remove Grok's confirmation prompts and are opt-in. With a UI, Pi shows the prompts that still arrive as dialogs, unless `/grok perms` is `yolo`, which selects allow once. Headless Pi uses `headlessPermissions`: the default `dialog` rejects, and `deny`, `reads`, `allow` are the other choices (`src/config.ts`). `yolo` selects allow once in headless Pi too.

Hook failures fail open, as Grok's own hooks do. The close-time guard answers pending requests once during orderly shutdown, with no ack deadlines. A hung-but-alive Pi is unguarded. A detached Pi session still denies every `pre_tool_use` (`src/model/connection.ts`, `test/transport.test.ts`).

Live probes are opt-in. The adapted model and Pi-restart probes have not been run for this implementation. Gateway-only probes exit 2. See [usage](usage.md#live-probes).

## 4. Launch gates

Each gate must pass before the first public post. Record runtime results in [`docs/launch-verification.md`](launch-verification.md), not here.

| Gate | Condition | Owner |
| --- | --- | --- |
| G2 | The README install path runs end to end in a clean `HOME` with a separate `PI_CODING_AGENT_DIR`. Passed 2026-09-28 for the clone, git, and npm paths, the npm path against the public registry after publication. | Main |
| G3 | Loading the extension does not spawn Grok; no secret file exists in this transport (`test/extension.test.ts`). | Main |
| G4 | Live claims have current results in [docs/launch-verification.md](launch-verification.md), with Node, Pi, and Grok versions. README claims without a result are reworded. Ordinary verification is already authorized. Run of 2026-09-28: 8 probes passed on Node.js 26.10.0, Pi 0.87.1, Grok Build 1.0.41. Steering effect and reconnect remain uncovered. | Main |
| G5 | Closed in code: the registered `input` handler acts only while the active provider is `grok` (`src/model.ts`, `test/extension.test.ts`). The live effect of an interjection on a running turn is still unverified, so keep steering out of the demo until a raw take shows it. | Main |
| G6 | README and `docs/first-class-model.md` fixes found in review (Node 22.19, stdio child lifetime, hung-Pi limit, qualified claims, broken references). | Main |
| G7 | Sanitized recordings and evidence. Before any recording, screenshot, transcript, or `evidence/` file is committed or posted, remove or redact prompts that are not demo prompts, `/grok debug` output and hook feedback that show paths, session IDs, or tokens, account details, and home paths (use `~/`). `evidence/` is in `.gitignore`, so probe results stay local. | Owner, Main |
| G8 | A demo recorded from a real run, per [`docs/demo.md`](demo.md), after G7. A take from 2026-09-28 exists, edited with title and end cards and the home path masked (checked by OCR on every quarter second of the turn). Not in the repository. | Owner |
| G9 | Channel links and rules checked on the day of each post (section 5). | Owner |
| G10 | The owner can answer replies for 48 hours after each post. | Owner |

G1 (license) is closed: Apache-2.0.

## 5. Channel drafts

All posts are future, owner-authorized actions. Rules for every channel:

- Link to the repository once. Stay for the replies.
- Ask for one specific kind of feedback.
- State the limits in the post.
- Never ask for stars or votes.
- Follow the schedule in section 6.

Placeholders: `{repo URL}` is `https://github.com/JangMan-J/pi-grok-agent`. `{demo URL}` comes from G8.

### 5.1 GitHub About, topics, and social preview (applied)

Applied and verified on 2026-09-28 with owner authorization. The [publication record](github-presentation.md) contains the commands, public image URL, and hash.

Live About description (since 2026-09-30):

> Grok Build as a model in Pi. Grok keeps its tools, so Pi can put it to work.

The 2026-09-28 description was: "Grok Build as a model in the Pi coding agent. Keep Grok's native tools and history, with Pi's transcript, tool gates, dialogs, and extension tools."

Website: empty until a separate useful destination exists.

Live topics:

```text
acp
acp-client
agent-client-protocol
agentic-coding
ai-agent
ai-coding-assistant
coding-agent
coding-assistant
grok
grok-4
grok-build
llm
mcp
model-context-protocol
model-provider
pi-coding-agent
pi-extension
pi-package
typescript
xai
```

The first 11 were applied on 2026-09-28. `acp-client`, `agentic-coding`, `ai-agent`, `ai-coding-assistant`, `coding-assistant`, `grok-4`, `llm`, `mcp`, and `model-context-protocol` were added on 2026-09-30, which reaches GitHub's limit of 20.
These are the owner-approved GitHub topics, not a copy of the package keywords. The live set includes `typescript`, not `pi`.
GitHub repository search checks the name, description, and topics by default, not README text.

Social image, uploaded 2026-09-28: [old/social-preview.png](assets/old/social-preview.png), 1280 × 640 pixels and 82,498 bytes.
The image was uploaded through GitHub Settings. The public page's `og:image` pointed to that upload.
The public image returned HTTP 200 and matched the local PNG byte for byte.
Replacement: [social-1280x640.png](assets/social-1280x640.png), 1280 × 640 pixels and 563,006 bytes. Uploaded through GitHub Settings on 2026-09-30. The public page's `og:image` points to that upload, which returned HTTP 200 and matched the local PNG byte for byte.

These settings are live. Repository file changes and launch announcements need separate owner authorization.

### 5.2 P0: Pi Discord

Check the invite on the Pi project pages and use the channel for projects.

> I built a Pi model provider for Grok Build: `pi --model grok/grok-4.7`.
>
> Grok keeps its own harness. Its native tools, permission rules, and history stay on the Grok side. Pi drives the turns and shows Grok's tool calls in the transcript. Pi can also gate Grok's tools, lend Pi extension tools over MCP, and show Grok's permission prompts and questions as Pi dialogs.
>
> It needs Node.js 22.19 or later (tested only on 26.10.0), Pi 0.87.1 (other Pi versions are untested), and a logged-in `grok` CLI. It starts one stdio agent child per Pi process. Apache-2.0.
>
> Tested versions: [docs/launch-verification.md](launch-verification.md). Until that page records a run, cite only the README set: Node.js 26.10.0, Pi 0.87.1, Grok Build 1.0.41. Known limits: no sandbox, video results show a path only, and Pi's copy of a tool result is shortened (Grok's is full).
>
> Repo: {repo URL}. Demo: {demo URL}.
>
> What I want to know: did the setup work on the first try? If not, which step failed?

### 5.3 P0: Pi GitHub Discussions

Post in `github.com/earendil-works/pi/discussions` only if a category for community projects exists. Title: "pi-grok-agent: Grok Build as a Pi model provider (feedback wanted)".

Body: the Discord text, plus:

- How it works: Pi's system prompt goes as `_meta.rules`, and only new messages go as `session/prompt`. Grok tool calls come back as ACP updates. Lent Pi tools use an in-process HTTP MCP server by default.
- Open questions for Pi maintainers: `onPayload` and `onResponse` are not called yet. Is there a better Pi surface for provider-native tool records than custom entries?
- Feedback template: section 8.

### 5.4 P1: r/PiCodingAgent

Read the subreddit rules first. It limits self-promotion. Lead with the use case.

> Title: Using Grok Build's own harness from Pi (model provider, direct stdio)
>
> I wanted Grok Build's native tools with Pi's session, gates, and extensions. This package makes `grok/grok-4.7` a Pi model. Grok still runs its own tools. Pi records each call and can deny edits in a read-only session.
>
> Demo and setup: {repo URL}. Requirements and limits are at the top of the README.
>
> Please send first-run reports: OS, Node, Pi, and Grok versions. If a step failed, name it.

### 5.5 P1: awesome-pi list entry (after the release tag, by PR only)

`BubblePtr/awesome-pi` asks for a PR with name, link, description, and install command. Check its current format first.

> - [pi-grok-agent]({repo URL}) - Grok Build as a Pi model provider. Grok keeps its native tools. Pi gates them and lends extension tools. Setup: `pi install npm:pi-grok-agent`.

`shaftoe/awesome-pi-coding-agent` says it is automatically curated. Do not open a PR there.

### 5.6 P2: X / Twitter

One post and one reply. Attach the demo clip.

> `pi --model grok/grok-4.7`: Grok Build runs its own harness and tools, and Pi drives the session. Pi records every Grok tool call, can deny edits in read-only mode, and shows Grok's permission prompts as dialogs. Direct stdio, loopback HTTP MCP. {repo URL}

Reply with one technical detail: Grok 1.0.41 drops MCP `annotations`, so read-only hints for lent tools go in `_meta`.

### 5.7 P2: LinkedIn

An engineering note, not a pitch:

1. The problem: you want a coding agent's own harness and tools, and you also want to keep a second agent UI.
2. The design choice: keep the tools on Grok's side, and use hooks and dialogs for control.
3. The limits: no sandbox, video results as a path only, shortened Pi-side tool output.
4. Who it does not fit: users without Grok Build access, or users who need a sandbox.

### 5.8 P2: DEV or a personal blog (outline)

Title idea: "Keeping a coding agent's harness when another agent drives it".

1. Dedicated stdio agents and the temporary HTTP-versus-SDK MCP comparison (`docs/first-class-model.md`).
2. Fail-open hook timeouts and close-time late-answer suppression (`test/transport.test.ts`).
3. Grok's `x.ai/tool` stamp as the classification source.
4. Measured numbers only from [docs/launch-verification.md](launch-verification.md).
5. The limits, and the feedback you want.

### 5.9 P2: Hacker News (author briefing, not post text)

HN guidelines forbid generated or AI-edited submissions and comments. Read the current Show HN rules before posting. The owner writes the title and text. This section gives facts only.

- Show HN needs something people can try. Pass all gates first, especially G2 and G4.
- Readers need a Grok Build login to try it. Say so early.
- Title facts: the project name, "Grok Build as a model provider for the Pi coding agent", no superlatives.
- Facts to have ready: the ACP flow (section 2), the child lifetime and permission facts (section 3), the 33 tracked unit tests, and the probe results in [docs/launch-verification.md](launch-verification.md).
- Likely questions: "Why not use Grok directly?" (Pi's transcript, extensions, gates). "Is it sandboxed?" (No.) "What does it cost?" (Grok account usage. The Pi footer shows Grok's reported cost.) "License?" (Apache-2.0.)
- Timing: the research found a 12-17 UTC window in a sample of 138 posts, with no proven cause. Pick a slot when you can answer for several hours.
- Post once. Do not ask others to vote or comment.

### 5.10 Deferred: Product Hunt and DevHunt

Defer both. The tool needs a Grok Build login and Pi, so a general audience cannot try it quickly. Reconsider after npm publication and a simpler install.

## 6. Schedule

One schedule. Some days pair two posts on purpose: the pair shares one audience or one clip.

| Day | Action (owner-authorized) | Exit condition |
| --- | --- | --- |
| Before | Close G2 to G10. Tag a pre-release (`v0.1.0`) with the release notes (section 7). About text, topics, and social preview (section 5.1) are already applied. | Clean-`HOME` run recorded in [docs/launch-verification.md](launch-verification.md) |
| 0 | Pi Discord. Pi GitHub Discussions, if a fitting category exists. | Replies answered. First-run failures logged as issues. |
| 1-2 | Fix first-run failures. Update the README troubleshooting table. Tag a patch if code changed. | No open first-run blocker |
| 3 | r/PiCodingAgent. X post with the clip. | |
| 5-7 | Show HN, only if first-run reports from Pi users are mostly successful. The owner writes it. | Owner present for replies |
| 7-10 | DEV write-up, then the LinkedIn note on a later day. | |
| 14-28 | awesome-pi PR. A follow-up release with fixes. | |

## 7. Release notes draft (v0.1.0, pre-release)

> pi-grok-agent 0.1.0 (pre-release)
>
> Grok Build as a Pi model provider. Select `grok/grok-4.7`, `grok-4.7-build-fast`, `grok-4.6`, or `grok-4.5`.
>
> What it does:
> - Grok runs its own harness: native tools, permission rules, subagents, and history.
> - Pi records each Grok tool call in the transcript. It can deny Grok's edit and shell tools (`/grok perms`).
> - Pi can run a check after each Grok edit, and hold the end of a turn until a command passes.
> - Pi extension tools can be lent to Grok over an in-process MCP server.
> - Grok's permission prompts and questions appear as Pi dialogs.
> - Generated images are copied to `.pi/grok-images/` and shown inline where the terminal supports images. Non-PNG previews need ImageMagick `magick`.
> - Mid-turn Enter steers into Grok's running turn. Alt+Enter queues a follow-up. (Keep this line only after a raw take shows the interjection's effect; see G5.)
>
> Requirements: Node.js 22.19 or later (tested only on 26.10.0), Pi 0.87.1 (other versions untested), and a logged-in Grok Build CLI. Tested versions: [docs/launch-verification.md](launch-verification.md).
>
> Limits: no sandbox. Video results show a path only. Image edit and video are unprobed. Pi's copy of Grok tool output is shortened; Grok keeps the full output. Hashline edits depend on your Grok config.
>
> License: Apache-2.0.

## 8. Metric plan

The main metric is first successful use: a user selects Grok and gets a turn with a `✓ grok` tool line in Pi.

| Signal | Source | How to read it |
| --- | --- | --- |
| First-run success reports | Replies, and a pinned "Did it work?" discussion or issue | Count successes and failures per step (install, server, load, first turn) |
| First-run failures | Issues with a `first-run` label | Each one is a README or code fix. Time to fix matters. |
| Clones and unique visitors | GitHub Insights, Traffic | GitHub keeps only 14 days. Save a copy every few days. |
| Referrers | GitHub Insights, Traffic | Shows which channel sent readers. Excludes search engines and GitHub itself. |
| Stars | GitHub | Secondary only. It does not show installs or use. |

Record a Traffic baseline before day 0.

Feedback template:

```text
OS:
Node version (node -v):
Pi version (pi --version):
Grok Build version (grok --version):
Install path (npm, git, or clone):
Last step that worked (npm install / Pi loaded / first Grok turn):
Error text, if any (redact paths, session IDs, and prompts you do not want public):
What you tried the provider on:
```

## 9. Owner decisions still open

Decided: the install path is npm (`pi install npm:pi-grok-agent`, stdio child on first turn). Published as `pi-grok-agent@0.1.0`.
- npm publication: done, `0.1.0`. A later release needs a version bump; npm refuses to publish over an existing version.
- Whether to commit sanitized `evidence/` results (G7).
- G3 is fixed in code. G5 is fixed in code; its live check is a demo gate.
- Video scope: document "path only", or add support.
- Which channels to use, and the handles to post from.

## 10. References

- Pi packages: https://pi.dev/docs/latest/packages (local copy: installed Pi `docs/packages.md`)
- Pi extensions: https://pi.dev/docs/latest/extensions
- Pi repository and discussions: https://github.com/earendil-works/pi
- Pi package gallery: https://pi.dev/packages
- GitHub topics: https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics
- GitHub repository search: https://docs.github.com/en/search-github/searching-on-github/searching-for-repositories
- GitHub traffic: https://docs.github.com/en/repositories/viewing-activity-and-data-for-your-repository/viewing-traffic-to-a-repository
- GitHub releases: https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository
- GitHub social preview: https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview
- Show HN guidelines: https://news.ycombinator.com/showhn.html
- HN guidelines: https://news.ycombinator.com/newsguidelines.html
- HN launch study (observational, 138 repositories): https://arxiv.org/html/2511.04453v1
- r/PiCodingAgent: https://www.reddit.com/r/PiCodingAgent/
- awesome-pi: https://github.com/BubblePtr/awesome-pi

Not verified in this phase: the Pi Discord invite, the subreddit rules, and the current awesome-pi format. Check them under G9.
