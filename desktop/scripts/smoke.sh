#!/bin/sh
set -eu

BASE=http://127.0.0.1:47321
TOKEN_FILE="${AGENT_FARM_DATA_DIR:-$HOME/Library/Application Support/AgentFarm}/token"
if [ ! -r "$TOKEN_FILE" ]; then
  echo "Missing token: $TOKEN_FILE (start the app once first)" >&2
  exit 1
fi
TOKEN=$(cat "$TOKEN_FILE")
STAMP=$(date +%s)
CLAUDE="smoke-claude-$STAMP"
CODEX="smoke-codex-$STAMP"

send() {
  source=$1
  body=$2
  curl --fail --silent --show-error -X POST "$BASE/ingest/$source" \
    -H "Host: 127.0.0.1:47321" -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' --data "$body" >/dev/null
}

send claude-code "{\"hook_event_name\":\"UserPromptSubmit\",\"session_id\":\"$CLAUDE\",\"cwd\":\"/tmp/AgentFarm\",\"prompt\":\"Claude smoke run\"}"
send claude-code "{\"hook_event_name\":\"PermissionRequest\",\"session_id\":\"$CLAUDE\",\"tool_name\":\"Bash\"}"
send claude-code "{\"hook_event_name\":\"UserPromptSubmit\",\"session_id\":\"$CLAUDE\"}"
send claude-code "{\"hook_event_name\":\"Stop\",\"session_id\":\"$CLAUDE\",\"last_assistant_message\":\"Claude smoke complete\"}"
send claude-code "{\"hook_event_name\":\"SessionEnd\",\"session_id\":\"$CLAUDE\"}"

send codex "{\"event\":\"prompt\",\"session_id\":\"$CODEX\",\"cwd\":\"/tmp/AgentFarm\",\"title\":\"Codex smoke run\"}"
send codex "{\"event\":\"stop\",\"session_id\":\"$CODEX\",\"message\":\"Codex smoke complete\"}"
send codex "{\"event\":\"end\",\"session_id\":\"$CODEX\"}"

curl --fail --silent --show-error "$BASE/api/farm?tz=$(date +%z | awk '{print (substr($0,1,1)=="-"?-1:1)*(substr($0,2,2)*60+substr($0,4,2))}')" \
  -H 'Host: 127.0.0.1:47321'
printf '\n'
