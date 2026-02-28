#!/usr/bin/env python3
"""Claude Code hook that emits OTel spans to an OTLP HTTP collector.

Install as PreToolUse, PostToolUse, SubagentStart, SubagentStop, and Stop hooks.
Each hook event reads JSON from stdin and sends spans via OTLP HTTP/JSON.

Usage in ~/.claude/settings.json:
{
  "hooks": {
    "PreToolUse":  [{"matcher": "", "hooks": [{"type": "command", "command": "python3 /path/to/otel-hook.py"}]}],
    "PostToolUse": [{"matcher": "", "hooks": [{"type": "command", "command": "python3 /path/to/otel-hook.py"}]}],
    "PostToolUseFailure": [{"matcher": "", "hooks": [{"type": "command", "command": "python3 /path/to/otel-hook.py"}]}],
    "SubagentStart": [{"matcher": "", "hooks": [{"type": "command", "command": "python3 /path/to/otel-hook.py"}]}],
    "SubagentStop":  [{"matcher": "", "hooks": [{"type": "command", "command": "python3 /path/to/otel-hook.py"}]}],
    "Stop":          [{"hooks": [{"type": "command", "command": "python3 /path/to/otel-hook.py"}]}]
  }
}
"""

import json, os, sys, time, uuid, urllib.request

OTEL_ENDPOINT = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318")
SPANS_URL = f"{OTEL_ENDPOINT}/v1/traces"
STATE_DIR = os.path.expanduser("~/.claude/otel-state")
SERVICE_NAME = "claude-code"

os.makedirs(STATE_DIR, exist_ok=True)


def rand_hex(n):
    return uuid.uuid4().hex[:n]


def get_session_trace_id(session_id):
    """Get or create a stable trace ID for this session."""
    path = os.path.join(STATE_DIR, f"trace-{session_id}")
    if os.path.exists(path):
        return open(path).read().strip()
    trace_id = rand_hex(32)
    with open(path, "w") as f:
        f.write(trace_id)
    return trace_id


def get_session_root_span_id(session_id):
    """Get or create a stable root span ID for this session."""
    path = os.path.join(STATE_DIR, f"root-{session_id}")
    if os.path.exists(path):
        return open(path).read().strip()
    span_id = rand_hex(16)
    with open(path, "w") as f:
        f.write(span_id)
    return span_id


def save_span_id(key, span_id):
    with open(os.path.join(STATE_DIR, f"span-{key}"), "w") as f:
        f.write(span_id)


def load_span_id(key):
    path = os.path.join(STATE_DIR, f"span-{key}")
    if os.path.exists(path):
        span_id = open(path).read().strip()
        os.remove(path)
        return span_id
    return None


def now_ns():
    return int(time.time() * 1e9)


def send_span(trace_id, span_id, parent_span_id, name, start_ns, end_ns, attributes, status_code=1):
    attrs = []
    for k, v in attributes.items():
        if v is None:
            continue
        if isinstance(v, (int, float)):
            attrs.append({"key": k, "value": {"intValue": str(int(v))}})
        else:
            attrs.append({"key": k, "value": {"stringValue": str(v)}})

    span = {
        "traceId": trace_id,
        "spanId": span_id,
        "name": name,
        "kind": 1,  # INTERNAL
        "startTimeUnixNano": str(start_ns),
        "endTimeUnixNano": str(end_ns),
        "attributes": attrs,
        "status": {"code": status_code},
    }
    if parent_span_id:
        span["parentSpanId"] = parent_span_id

    payload = {
        "resourceSpans": [{
            "resource": {
                "attributes": [
                    {"key": "service.name", "value": {"stringValue": SERVICE_NAME}},
                ]
            },
            "scopeSpans": [{
                "scope": {"name": "claude-code-hooks", "version": "1.0.0"},
                "spans": [span],
            }],
        }]
    }

    try:
        req = urllib.request.Request(
            SPANS_URL,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=5)
    except Exception:
        pass  # Don't break Claude Code if collector is down


def handle_pre_tool_use(data):
    session_id = data["session_id"]
    tool_use_id = data.get("tool_use_id", rand_hex(16))
    span_id = rand_hex(16)
    save_span_id(tool_use_id, span_id)
    # Save start time
    save_span_id(f"{tool_use_id}-start", str(now_ns()))


def handle_post_tool_use(data, failed=False):
    session_id = data["session_id"]
    tool_use_id = data.get("tool_use_id", "")
    trace_id = get_session_trace_id(session_id)
    root_span_id = get_session_root_span_id(session_id)
    span_id = load_span_id(tool_use_id) or rand_hex(16)
    start_ns = int(load_span_id(f"{tool_use_id}-start") or str(now_ns()))
    end_ns = now_ns()

    tool_name = data.get("tool_name", "unknown")
    attrs = {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": tool_name,
        "gen_ai.tool.call.id": tool_use_id,
    }
    tool_input = data.get("tool_input")
    if tool_input:
        attrs["gen_ai.tool.call.arguments"] = json.dumps(tool_input)[:1000]
    if not failed:
        tool_response = data.get("tool_response")
        if tool_response:
            attrs["gen_ai.tool.call.result"] = json.dumps(tool_response)[:1000]

    status = 2 if failed else 1  # ERROR=2, OK=1
    send_span(trace_id, span_id, root_span_id,
              f"execute_tool {tool_name}", start_ns, end_ns, attrs, status)


def handle_subagent_start(data):
    session_id = data["session_id"]
    agent_id = data.get("agent_id", rand_hex(16))
    span_id = rand_hex(16)
    save_span_id(f"agent-{agent_id}", span_id)
    save_span_id(f"agent-{agent_id}-start", str(now_ns()))


def handle_subagent_stop(data):
    session_id = data["session_id"]
    agent_id = data.get("agent_id", "")
    trace_id = get_session_trace_id(session_id)
    root_span_id = get_session_root_span_id(session_id)
    span_id = load_span_id(f"agent-{agent_id}") or rand_hex(16)
    start_ns = int(load_span_id(f"agent-{agent_id}-start") or str(now_ns()))

    agent_type = data.get("agent_type", "unknown")
    send_span(trace_id, span_id, root_span_id,
              f"invoke_agent {agent_type}", start_ns, now_ns(), {
                  "gen_ai.operation.name": "invoke_agent",
                  "gen_ai.agent.id": agent_id,
                  "gen_ai.agent.name": agent_type,
              })


def handle_stop(data):
    session_id = data["session_id"]
    trace_id = get_session_trace_id(session_id)
    root_span_id = get_session_root_span_id(session_id)

    # Read session start time or use a default
    start_path = os.path.join(STATE_DIR, f"session-start-{session_id}")
    if os.path.exists(start_path):
        start_ns = int(open(start_path).read().strip())
    else:
        # First stop — approximate start as 30s ago
        start_ns = now_ns() - 30_000_000_000

    # Emit the root session span
    send_span(trace_id, root_span_id, None,
              "invoke_agent claude-code", start_ns, now_ns(), {
                  "gen_ai.operation.name": "invoke_agent",
                  "gen_ai.agent.name": "claude-code",
                  "gen_ai.provider.name": "anthropic",
              })

    # Clean up state files for this session
    for f in os.listdir(STATE_DIR):
        if session_id in f:
            os.remove(os.path.join(STATE_DIR, f))


def main():
    data = json.load(sys.stdin)
    event = data.get("hook_event_name", "")

    # On first event for a session, record start time
    session_id = data.get("session_id", "")
    if session_id:
        start_path = os.path.join(STATE_DIR, f"session-start-{session_id}")
        if not os.path.exists(start_path):
            with open(start_path, "w") as f:
                f.write(str(now_ns()))
        # Ensure trace/root IDs exist
        get_session_trace_id(session_id)
        get_session_root_span_id(session_id)

    if event == "PreToolUse":
        handle_pre_tool_use(data)
    elif event == "PostToolUse":
        handle_post_tool_use(data)
    elif event == "PostToolUseFailure":
        handle_post_tool_use(data, failed=True)
    elif event == "SubagentStart":
        handle_subagent_start(data)
    elif event == "SubagentStop":
        handle_subagent_stop(data)
    elif event == "Stop":
        handle_stop(data)


if __name__ == "__main__":
    main()
