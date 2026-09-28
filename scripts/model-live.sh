#!/usr/bin/env bash
# Live check: a real `pi -p` process uses model grok/<id>. With the default policy Grok does the work
# on its own harness (read_file/write via Grok), Pi observes. PI_GROK_PI_TOOLS=all flips it to Pi tools.
# Usage: scripts/model-live.sh [standalone|gateway] [model-id]
set -u
MODE="${1:-standalone}"; MODEL="${2:-grok-4.7}"
cd "$(dirname "$0")/.."
if [ "$MODE" = standalone ]; then
  PORT=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
  SECRET=$(node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')
  GROK_AGENT_SECRET=$SECRET "${PI_GROK_BINARY:-grok}" --permission-mode default agent --no-leader serve --bind 127.0.0.1:$PORT > /tmp/grok-model-live-server.log 2>&1 &
  SERVER=$!
  until node -e 'require("net").connect(process.argv[1],"127.0.0.1").on("connect",()=>process.exit(0)).on("error",()=>process.exit(1))' "$PORT"; do sleep 0.3; done
  export GROK_ACP_URL=ws://127.0.0.1:$PORT/ws GROK_AGENT_SECRET=$SECRET
fi
W=$(mktemp -d /tmp/pi-grok-model-XXXXXX)
TOKEN=$(node -e 'console.log(require("crypto").randomBytes(10).toString("hex"))')
echo "$TOKEN" > "$W/token.txt"
# Headless Pi has no dialog for Grok's native permission prompts (e.g. a shell redirect that writes a file); allow them here.
export PI_GROK_HEADLESS_PERMISSIONS="${PI_GROK_HEADLESS_PERMISSIONS:-allow}"
PROMPT="Read token.txt in the current directory, then create done.txt containing the word finished. Reply with only the token."
OUT=$(cd "$W" && timeout 300 pi --model "grok/$MODEL" --no-session --no-context-files --no-skills --no-prompt-templates -p "$PROMPT" 2>&1)
RC=$?
DONE_AFTER_FIRST=0; grep -q finished "$W/done.txt" 2>/dev/null && DONE_AFTER_FIRST=1
# Which side executed the tools: Pi's own tool log (JSON mode) or Grok's harness (observed as [grok ...] thoughts)
GROK_LOG=/tmp/grok-model-live-server.log; [ "$MODE" = gateway ] && GROK_LOG="$HOME/.pi/agent/grok-ws.log"
JSONOUT=$(cd "$W" && rm -f done.txt && timeout 300 pi --model "grok/$MODEL" --no-session --no-context-files --no-skills --no-prompt-templates --mode json -p "$PROMPT" 2>/dev/null)
PI_TOOL_CALLS=$(printf '%s' "$JSONOUT" | rg -c '"type":"tool_execution_start"' || true)
GROK_TOOL_OBS=$(printf '%s' "$JSONOUT" | rg -o '\[grok [a-z_]+\]' | sort | uniq -c | tr '\n' ';' || true)
[ -n "${SERVER:-}" ] && kill "$SERVER" 2>/dev/null
PASS=1
echo "$OUT" | grep -q "$TOKEN" || { echo "FAIL: token missing from Pi output"; PASS=0; }
[ "$DONE_AFTER_FIRST" = 1 ] || { echo "FAIL: done.txt not written"; PASS=0; }
POLICY="${PI_GROK_PI_TOOLS:-extensions}"
if [ "$POLICY" = extensions ] || [ "$POLICY" = none ]; then
  [ "${PI_TOOL_CALLS:-0}" = 0 ] || { echo "FAIL: Pi executed $PI_TOOL_CALLS tool(s); Grok should have used its own harness"; PASS=0; }
  [ -n "$GROK_TOOL_OBS" ] || { echo "FAIL: no Grok-native tool activity observed"; PASS=0; }
else
  # Pi tools are offered in addition to Grok's harness; Grok chooses. model-probe.ts proves the Pi channel with a Pi-only tool.
  echo "INFO: policy $POLICY: Pi executed ${PI_TOOL_CALLS:-0} tool(s); Grok native: ${GROK_TOOL_OBS:-none}"
fi
DONE_AFTER_FIRST=$DONE_AFTER_FIRST node -e '
const fs=require("fs");const [mode,model,token,out,w,pass,rc,policy,piCalls,grokObs]=process.argv.slice(1);
const ev={mode,model,piToolPolicy:policy,headlessPermissions:process.env.PI_GROK_HEADLESS_PERMISSIONS,binary:(()=>{try{return require("fs").readFileSync(require("os").homedir()+"/.pi/agent/grok-ws.log","utf8").trim().split("\n").filter(l=>l.includes("binary ")).pop().split("binary ").pop()}catch{return undefined}})(),tokenReturned:out.includes(token),doneWritten:process.env.DONE_AFTER_FIRST==="1",piToolExecutions:Number(piCalls||0),grokNativeToolsObserved:grokObs,piExit:Number(rc),ok:pass==="1",output:out.slice(-800)};
fs.writeFileSync("evidence/model-live-"+mode+"-"+policy.replace(/[^a-z]/g,"")+".json",JSON.stringify(ev,null,2)+"\n");console.log(JSON.stringify(ev,null,2));' "$MODE" "$MODEL" "$TOKEN" "$OUT" "$W" "$PASS" "$RC" "$POLICY" "$PI_TOOL_CALLS" "$GROK_TOOL_OBS"
[ "$PASS" = 1 ]
