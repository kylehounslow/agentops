#!/usr/bin/env /usr/bin/python3
"""Called by otel-hook.sh for the Stop event. Parses transcript, emits chat spans."""
import json, sys, os, time, uuid, urllib.request

OTEL_ENDPOINT = "http://localhost:4318/v1/traces"
STATE_DIR = os.path.expanduser("~/.claude/otel-state")

def send_span(trace_id, span_id, parent_id, name, start_ns, end_ns, attrs):
    otel_attrs = []
    for k, v in attrs.items():
        if v is None:
            continue
        if isinstance(v, int):
            otel_attrs.append({"key": k, "value": {"intValue": str(v)}})
        else:
            otel_attrs.append({"key": k, "value": {"stringValue": str(v)}})

    span = {
        "traceId": trace_id, "spanId": span_id, "name": name,
        "kind": 3, "startTimeUnixNano": str(start_ns), "endTimeUnixNano": str(end_ns),
        "attributes": otel_attrs, "status": {"code": 1},
    }
    if parent_id:
        span["parentSpanId"] = parent_id

    payload = {"resourceSpans": [{"resource": {"attributes": [
        {"key": "service.name", "value": {"stringValue": "claude-code"}}
    ]}, "scopeSpans": [{"scope": {"name": "claude-code-hooks"}, "spans": [span]}]}]}

    try:
        req = urllib.request.Request(OTEL_ENDPOINT, data=json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        urllib.request.urlopen(req, timeout=5)
    except Exception:
        pass

def main():
    data = json.load(sys.stdin)
    transcript_path = data.get("transcript_path", "")
    session_id = data.get("session_id", "")

    if not transcript_path or not os.path.exists(transcript_path):
        return

    trace_id = open(os.path.join(STATE_DIR, f"trace-{session_id}")).read().strip()
    root_span_id = open(os.path.join(STATE_DIR, f"root-{session_id}")).read().strip()

    # Parse transcript JSONL
    messages = []
    with open(transcript_path) as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    messages.append(json.loads(line))
                except json.JSONDecodeError:
                    pass

    # Pair user→assistant and emit chat spans
    last_user_text = ""
    now_ns = int(time.time() * 1e9)
    prev_ts_ns = None

    for msg in messages:
        if msg.get("type") == "user":
            content = msg.get("message", {}).get("content", "")
            if isinstance(content, str):
                last_user_text = content[:500]
            elif isinstance(content, list):
                parts = [p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text"]
                last_user_text = " ".join(parts)[:500]
            # Track timestamp
            ts_str = msg.get("timestamp", "")
            if ts_str:
                from datetime import datetime
                try:
                    dt = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                    prev_ts_ns = int(dt.timestamp() * 1e9)
                except Exception:
                    pass

        elif msg.get("type") == "assistant":
            m = msg.get("message", {})
            usage = m.get("usage", {})
            content_blocks = m.get("content", [])

            # Extract text output (skip thinking blocks)
            text_parts = []
            for block in content_blocks:
                if isinstance(block, dict) and block.get("type") == "text":
                    text_parts.append(block.get("text", ""))
            output_text = "".join(text_parts).strip()[:500]

            # Extract tool calls for context
            tool_calls = []
            for block in content_blocks:
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    tool_calls.append(block.get("name", ""))

            # Use previous message timestamp as start, this message as end
            # This approximates the actual LLM call duration
            ts_str = msg.get("timestamp", "")
            span_end_ns = now_ns
            if ts_str:
                from datetime import datetime
                try:
                    dt = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                    span_end_ns = int(dt.timestamp() * 1e9)
                except Exception:
                    pass
            span_start_ns = prev_ts_ns if prev_ts_ns else span_end_ns - 1000000
            now_ns = max(now_ns, span_end_ns)

            attrs = {
                "gen_ai.operation.name": "chat",
                "gen_ai.provider.name": "anthropic",
                "gen_ai.request.model": m.get("model", "unknown"),
                "gen_ai.response.model": m.get("model", "unknown"),
                "gen_ai.response.id": m.get("id", ""),
                "gen_ai.response.finish_reasons": json.dumps([m.get("stop_reason") or "unknown"]),
                "gen_ai.usage.input_tokens": usage.get("input_tokens", 0),
                "gen_ai.usage.output_tokens": usage.get("output_tokens", 0),
                "gen_ai.usage.cache_read.input_tokens": usage.get("cache_read_input_tokens", 0),
                "gen_ai.usage.cache_creation.input_tokens": usage.get("cache_creation_input_tokens", 0),
                "gen_ai.input.messages": last_user_text,
                "gen_ai.output.messages": output_text if output_text else (f"[tool_use: {', '.join(tool_calls)}]" if tool_calls else ""),
            }

            span_id = uuid.uuid4().hex[:16]

            send_span(trace_id, span_id, root_span_id,
                      f"chat {m.get('model', 'unknown')}", span_start_ns, span_end_ns, attrs)

            prev_ts_ns = span_end_ns

    # Emit root span — use earliest transcript timestamp as start
    try:
        start_ns = int(open(os.path.join(STATE_DIR, f"start-{session_id}")).read().strip())
    except Exception:
        start_ns = int(time.time() * 1e9)

    # Find earliest message timestamp to ensure root encompasses all children
    for msg in messages:
        ts_str = msg.get("timestamp", "")
        if ts_str:
            from datetime import datetime
            try:
                dt = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                msg_ns = int(dt.timestamp() * 1e9)
                start_ns = min(start_ns, msg_ns)
            except Exception:
                pass

    end_ns = int(time.time() * 1e9)
    send_span(trace_id, root_span_id, None, "invoke_agent claude-code", start_ns, end_ns, {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": "claude-code",
        "gen_ai.provider.name": "anthropic",
    })

    # Cleanup
    for f in os.listdir(STATE_DIR):
        if session_id in f:
            os.remove(os.path.join(STATE_DIR, f))

if __name__ == "__main__":
    main()
