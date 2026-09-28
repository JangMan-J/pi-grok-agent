#!/usr/bin/env bash
# Live checks for the three Grok client-hook layers, driven by real `pi -p --model grok/<id>` runs.
# Evidence: evidence/hooks-live.json
set -u
cd "$(dirname "$0")/.."
MODEL="${1:-grok-4.7}"
export PI_GROK_HEADLESS_PERMISSIONS=allow
COMMON=(--no-session --no-context-files --no-skills --no-prompt-templates --mode json)
run_pi() { timeout 400 pi --model "grok/$MODEL" "${COMMON[@]}" "$@" 2>/dev/null; }
grok_tools() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const seen=[];for(const l of s.split("\n")){let e;try{e=JSON.parse(l)}catch{continue}if(e.type==="message_end"&&e.message?.role==="assistant")for(const c of e.message.content)if(c.type==="thinking")for(const m of c.thinking.matchAll(/\[grok ([a-z_]+)( (completed|failed))?\]/g))seen.push(m[1]+(m[3]?":"+m[3]:""))}console.log(seen.join(","))})'; }
final_text() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let t="";for(const l of s.split("\n")){let e;try{e=JSON.parse(l)}catch{continue}if(e.type==="message_end"&&e.message?.role==="assistant")for(const c of e.message.content)if(c.type==="text")t=c.text}console.log(t.slice(0,300))})'; }
PASS=1; R=()

# 1. Gate: read-only Pi session. Grok must not be able to write.
W=$(mktemp -d /tmp/grok-hooks-gate-XXXX); printf 'alpha = 1\n' > "$W/settings.py"
OUT=$(cd "$W" && run_pi --tools read,grep,find,ls -p "Change alpha from 1 to 2 in settings.py. If a tool is denied, stop and say exactly which tool was denied and why.")
TOOLS=$(printf '%s' "$OUT" | grok_tools); TEXT=$(printf '%s' "$OUT" | final_text)
if grep -q 'alpha = 1' "$W/settings.py" && printf '%s' "$TOOLS" | rg -q '(hashline_edit|write|search_replace|run_terminal_command):failed'; then R+=("gate: PASS ($TOOLS)"); else PASS=0; R+=("gate: FAIL tools=$TOOLS file=$(cat "$W/settings.py" | tr '\n' ' ')"); fi
GATE_TEXT="$TEXT"

# 2. Post-edit context: an edit that breaks syntax gets a check failure fed back; Grok repairs it in the same turn.
W2=$(mktemp -d /tmp/grok-hooks-post-XXXX); printf 'export function add(a: number, b: number): number {\n  return a + b;\n}\n' > "$W2/math.ts"
OUT2=$(cd "$W2" && run_pi -p "In math.ts, rename the function add to sum using a single hashline_edit that replaces only line 1 with exactly this text (note it is intentionally missing the closing brace of the parameter list, do not fix it in that first edit): export function sum(a: number, b: number: number { . After that first edit, if you receive any feedback that a check failed, fix the file so it is valid TypeScript. Finally reply with the word done.")
TOOLS2=$(printf '%s' "$OUT2" | grok_tools)
if node --no-warnings --experimental-vm-modules -e 'const {stripTypeScriptTypes}=require("node:module");new (require("node:vm").SourceTextModule)(stripTypeScriptTypes(require("fs").readFileSync(process.argv[1],"utf8")))' "$W2/math.ts" 2>/dev/null && grep -q 'function sum' "$W2/math.ts" && [ "$(printf '%s' "$TOOLS2" | rg -o 'hashline_edit:completed|write:completed|search_replace:completed' | wc -l)" -ge 2 ]; then R+=("post-edit: PASS ($TOOLS2)"); else PASS=0; R+=("post-edit: FAIL tools=$TOOLS2 file=$(tr '\n' ' ' < "$W2/math.ts")"); fi

# 3. Stop gate: acceptance requires done.txt; Grok is told nothing about it and must be held until it exists.
W3=$(mktemp -d /tmp/grok-hooks-stop-XXXX)
OUT3=$(cd "$W3" && PI_GROK_STOP_CHECK='test -f done.txt' run_pi -p "Reply with the single word ready and nothing else. Do not create any files unless you are told that a check failed; in that case do exactly what the failure message needs.")
TOOLS3=$(printf '%s' "$OUT3" | grok_tools); TEXT3=$(printf '%s' "$OUT3" | final_text)
if [ -f "$W3/done.txt" ]; then R+=("stop: PASS (done.txt created after block; tools=$TOOLS3)"); else PASS=0; R+=("stop: FAIL no done.txt; tools=$TOOLS3 text=$TEXT3"); fi

node -e '
const fs=require("fs");const [pass,gateText,model,...results]=process.argv.slice(1);
const ev={model,ok:pass==="1",results,gateAnswer:gateText};
fs.writeFileSync("evidence/hooks-live.json",JSON.stringify(ev,null,2)+"\n");console.log(JSON.stringify(ev,null,2));' "$PASS" "$GATE_TEXT" "$MODEL" "${R[@]}"
[ "$PASS" = 1 ]
