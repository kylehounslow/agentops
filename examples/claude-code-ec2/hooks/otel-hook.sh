#!/bin/bash
# Claude Code hook → OTel spans via OTLP HTTP/JSON
# Tool/agent spans emitted in real-time. Chat spans reconstructed from transcript on Stop.

OTEL_ENDPOINT="http://localhost:4318"
STATE_DIR="$HOME/.claude/otel-state"
HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$STATE_DIR"

INPUT=$(cat)
EVENT=$(echo "$INPUT" | /usr/bin/jq -r '.hook_event_name')
SESSION_ID=$(echo "$INPUT" | /usr/bin/jq -r '.session_id')

TRACE_FILE="$STATE_DIR/trace-$SESSION_ID"
if [ -f "$TRACE_FILE" ]; then TRACE_ID=$(cat "$TRACE_FILE")
else TRACE_ID=$(cat /proc/sys/kernel/random/uuid | tr -d '-'); echo -n "$TRACE_ID" > "$TRACE_FILE"; fi

ROOT_FILE="$STATE_DIR/root-$SESSION_ID"
if [ -f "$ROOT_FILE" ]; then ROOT_SPAN_ID=$(cat "$ROOT_FILE")
else ROOT_SPAN_ID=$(cat /proc/sys/kernel/random/uuid | tr -d '-' | head -c 16); echo -n "$ROOT_SPAN_ID" > "$ROOT_FILE"; fi

START_FILE="$STATE_DIR/start-$SESSION_ID"
NOW_NS=$(date +%s%N)
[ ! -f "$START_FILE" ] && echo -n "$NOW_NS" > "$START_FILE"

send_span() {
  local sid="$1" parent="$2" name="$3" start="$4" end="$5" attrs="$6"
  local pf=""; [ -n "$parent" ] && pf="\"parentSpanId\":\"$parent\","
  /usr/bin/curl -s -o /dev/null -X POST "$OTEL_ENDPOINT/v1/traces" \
    -H "Content-Type: application/json" \
    -d "{\"resourceSpans\":[{\"resource\":{\"attributes\":[{\"key\":\"service.name\",\"value\":{\"stringValue\":\"claude-code\"}}]},\"scopeSpans\":[{\"scope\":{\"name\":\"claude-code-hooks\"},\"spans\":[{\"traceId\":\"$TRACE_ID\",\"spanId\":\"$sid\",$pf\"name\":\"$name\",\"kind\":1,\"startTimeUnixNano\":\"$start\",\"endTimeUnixNano\":\"$end\",\"attributes\":[$attrs],\"status\":{\"code\":1}}]}]}]}" &
}

case "$EVENT" in
  PreToolUse)
    TUI=$(echo "$INPUT" | /usr/bin/jq -r '.tool_use_id // empty')
    SID=$(cat /proc/sys/kernel/random/uuid | tr -d '-' | head -c 16)
    echo -n "$SID" > "$STATE_DIR/span-$TUI"
    echo -n "$NOW_NS" > "$STATE_DIR/time-$TUI"
    ;;
  PostToolUse|PostToolUseFailure)
    TUI=$(echo "$INPUT" | /usr/bin/jq -r '.tool_use_id // empty')
    TN=$(echo "$INPUT" | /usr/bin/jq -r '.tool_name // "unknown"')
    SID=$(cat "$STATE_DIR/span-$TUI" 2>/dev/null || cat /proc/sys/kernel/random/uuid | tr -d '-' | head -c 16)
    SNS=$(cat "$STATE_DIR/time-$TUI" 2>/dev/null || echo "$NOW_NS")
    rm -f "$STATE_DIR/span-$TUI" "$STATE_DIR/time-$TUI"
    A="{\"key\":\"gen_ai.operation.name\",\"value\":{\"stringValue\":\"execute_tool\"}},{\"key\":\"gen_ai.tool.name\",\"value\":{\"stringValue\":\"$TN\"}},{\"key\":\"gen_ai.tool.call.id\",\"value\":{\"stringValue\":\"$TUI\"}}"
    send_span "$SID" "$ROOT_SPAN_ID" "execute_tool $TN" "$SNS" "$NOW_NS" "$A"
    ;;
  SubagentStart)
    AID=$(echo "$INPUT" | /usr/bin/jq -r '.agent_id // empty')
    SID=$(cat /proc/sys/kernel/random/uuid | tr -d '-' | head -c 16)
    echo -n "$SID" > "$STATE_DIR/agent-$AID"
    echo -n "$NOW_NS" > "$STATE_DIR/atime-$AID"
    ;;
  SubagentStop)
    AID=$(echo "$INPUT" | /usr/bin/jq -r '.agent_id // empty')
    AT=$(echo "$INPUT" | /usr/bin/jq -r '.agent_type // "unknown"')
    SID=$(cat "$STATE_DIR/agent-$AID" 2>/dev/null || cat /proc/sys/kernel/random/uuid | tr -d '-' | head -c 16)
    SNS=$(cat "$STATE_DIR/atime-$AID" 2>/dev/null || echo "$NOW_NS")
    rm -f "$STATE_DIR/agent-$AID" "$STATE_DIR/atime-$AID"
    A="{\"key\":\"gen_ai.operation.name\",\"value\":{\"stringValue\":\"invoke_agent\"}},{\"key\":\"gen_ai.agent.name\",\"value\":{\"stringValue\":\"$AT\"}},{\"key\":\"gen_ai.agent.id\",\"value\":{\"stringValue\":\"$AID\"}}"
    send_span "$SID" "$ROOT_SPAN_ID" "invoke_agent $AT" "$SNS" "$NOW_NS" "$A"
    ;;
  Stop)
    echo "$INPUT" | /usr/bin/python3 "$HOOK_DIR/stop-handler.py"
    ;;
esac

wait
exit 0
