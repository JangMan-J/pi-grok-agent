# Demo storyboard

This page is a plan for a 30 to 60 second demo clip of pi-grok-agent. No capture exists yet. Record every shot from a real session. Do not use mock output, and do not show a result that the raw recording does not contain.

The clip shows one idea: Grok Build's own agent does the work inside Pi, and Pi keeps control of the session.

## Rules for the edited clip

- Keep the raw recording and the Pi session file of each take.
- Every cut inside a Grok turn gets an on-screen label, for example `time cut: 38 s`. Use the real elapsed time from the recording or from the durations in the `grok-tool` lines.
- A speed ramp gets a label, for example `4x`.
- Do not cut a media generation so that the image appears to arrive at once. Show the label with the real generation time.
- If a shot does not give the expected result, retake it or remove it. Do not add captions that claim a result that is not on screen.
- Show the versions in the end card as recorded: Node.js, Pi, Grok Build, model ID, and terminal.
- Publish only reviewed excerpts of the synthetic demo project. Do not publish raw logs, session files, or `evidence/` files. Blur or crop secrets, tokens, session IDs (including `/grok debug` output), and private paths in every frame.
- Stay on `grok/grok-4.7` for the whole take. Do not switch models inside the Pi session.

## Preparation

Record in a terminal that shows images inline, so that the image shot works. Install ImageMagick (`magick`), because `image_gen` wrote JPEG in development runs, and Pi needs `magick` to show JPEG, WebP, or GIF inline. PNG needs no converter. Log in with `grok login` before you record.

Use a separate Pi agent directory and a scratch demo project. Each Pi starts its own stdio agent child (`src/model/connection.ts`); no separate transport terminal is needed. Live stdio-direct behavior is still pending validation, so rehearse before recording.

```sh
export PI_CODING_AGENT_DIR="$HOME/.pi-grok-demo/agent"
export CLONE="$HOME/pi-grok-agent"   # change to the path of your clone
cd "$CLONE"
npm install --omit=dev
```

Demo project (recorded):

```sh
DEMO=$(mktemp -d)
cd "$DEMO"
git init -q
cat > sum.mjs <<'EOF'
export function sum(values) {
  let total = 0;
  for (let i = 1; i < values.length; i++) total += values[i];
  return total;
}
EOF
cat > sum.test.mjs <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sum } from './sum.mjs';

test('sum adds every value', () => {
  assert.equal(sum([2, 3, 4]), 9);
});
EOF
node --test
```

`node --test` must fail with `7 !== 9` before the take starts. The bug is the loop start index.

Rehearse the full take once. The rehearsal shows the tool names that Grok selects with your Grok configuration, and it shows how long each turn takes. Then reset the project with the same commands in a new directory.

## Shot list

The times are for the edited clip. Real turns take longer and get time-cut labels.

| Time | Shot | Input | Expected visible result |
| --- | --- | --- | --- |
| 0:00 to 0:04 | Title card | None | Text: "Grok Build's own agent, as a Pi model". Subtitle: `pi --model grok/grok-4.7`. |
| 0:04 to 0:08 | The failing test | `node --test` in the demo terminal | Real failure output with `7 !== 9`. |
| 0:08 to 0:11 | Start Pi | `pi -e "$CLONE" --model grok/grok-4.7` | Pi starts. The footer shows the selected Grok model. |
| 0:11 to 0:26 | Grok fixes the bug | Prompt 1 (below) | `grok-tool` lines, one for each Grok tool call, for example `✓ grok read_file …`, an edit tool, and a shell tool, each with a duration. Routine calls may be grouped as `grok-tools` rows; native calls are not thinking text (`src/model/session.ts`). A final answer that says the test passes. If Grok asks for permission, a Pi dialog appears. Select the allow-once option on camera. |
| 0:26 to 0:30 | Proof of the fix | `!!cat sum.mjs` then `!!node --test` | The loop starts at `0`. The test passes. |
| 0:30 to 0:40 | Pi's gate on Grok | `/grok perms read-only`, then prompt 2 | A notice `Grok permission mode: readonly`. A denied line such as `⊘ grok search_replace …` with `denied: This Pi session is read-only: no file edits or writes. Report findings instead.` Grok's answer reports the denial. |
| 0:40 to 0:42 | Restore the gate | `/grok perms auto` | A notice `Grok permission mode: auto`. |
| 0:42 to 0:54 | Grok generates an image | Prompt 3 | `✓ grok image_gen …` with `saved …/.pi/grok-images/…`. After the turn, the image shows inline. Label with the real generation time. |
| 0:54 to 1:00 | End card | None | Clone URL, requirements (Grok Build CLI with login; tested with Pi 0.87.1 and Grok Build 1.0.41), "Apache-2.0", and "Feedback: open an issue". Recorded versions in small text. |

Prompts:

1. `sum.test.mjs fails. Find the bug in sum.mjs, fix it, and run node --test to confirm. Keep the answer short.`
2. `Change the test to expect 10 instead of 9.`
3. `Use image_gen once to make a small flat icon of a red circle on a white background. Reply with the saved path only.`

## Shots that can fail

| Shot | Condition to keep it | If the condition fails |
| --- | --- | --- |
| Gate | A denied `grok-tool` line appears, and the test file still expects `9`. | Retake. Do not show a different outcome as a denial. |
| Image | The `saved` line and the inline image appear. | Without image support or `magick`, only the path shows. Change the terminal or remove the shot. |
| Tool names | Any tool names are acceptable. | Do not rename tools in the edit. Hashline tools appear only with `[toolset] file_toolset = "hashline"` in `~/.grok/config.toml`. |

## Steering shot (omitted)

The clip has no steering shot. The live effect of mid-turn Enter on a running Grok turn is not yet verified. Add the shot only after a raw take shows the effect in the same turn: for example, send `Also add a one-line comment above the loop that explains the start index.` with Enter while prompt 1 runs, and `cat sum.mjs` after that turn shows the comment. The `→ steered into Grok's turn` line alone is only an acknowledgment. It does not prove that Grok used the text.

## Capture notes

- Terminal text recorders can fail to show inline images in playback. Use a screen recorder for the image shot, or for the whole take.
- Use a large font and a terminal width of 100 to 120 columns.
- Hide unrelated shell history, tokens, and paths in the home directory before the take.
- `/grok debug` gives a good still frame for a post or an issue: stdio child, session, modes, usage, and cost. Blur the Grok session ID before you publish it.

## After the take

1. Check that each kept shot matches the "Expected visible result" column in the raw recording.
2. Write the transcript of the edited clip (commands, prompts, and visible results) next to the clip, so that a reader can compare them. Redact it as the clip is redacted.
3. Record the date, versions, model ID, terminal, and the real duration of each Grok turn.

## Cleanup

```sh
rm -rf "$DEMO"
rm -rf "$HOME/.pi-grok-demo"
```

Exit Pi before removing the scratch directories. Pi closes its stdio agent child. Grok manages its stored sessions under `~/.grok/`.
