import "./tracing.js";
import express from "express";
import expressWs from "express-ws";
import { trace, SpanStatusCode, SpanKind, context as otelContext } from "@opentelemetry/api";
import { query } from "@anthropic-ai/claude-agent-sdk";

const app = express();
expressWs(app);
app.use(express.json());
app.use(express.static("public"));

const tracer = trace.getTracer("claude-code-traced", "1.0.0");

let activeParentCtx = null;
const toolSpans = new Map();
const agentSpans = new Map();

function createHooks() {
  return {
    PreToolUse: [{ hooks: [async (input) => {
      const ctx = activeParentCtx || otelContext.active();
      const span = tracer.startSpan(`execute_tool ${input.tool_name}`, {
        kind: SpanKind.INTERNAL,
        attributes: {
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": input.tool_name,
          "gen_ai.tool.call.id": input.tool_use_id,
        },
      }, ctx);
      if (input.tool_input) {
        span.setAttribute("gen_ai.tool.call.arguments", JSON.stringify(input.tool_input).slice(0, 1000));
      }
      toolSpans.set(input.tool_use_id, span);
      return { continue: true };
    }] }],
    PostToolUse: [{ hooks: [async (input) => {
      const span = toolSpans.get(input.tool_use_id);
      if (span) {
        if (input.tool_response) {
          span.setAttribute("gen_ai.tool.call.result", JSON.stringify(input.tool_response).slice(0, 1000));
        }
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
        toolSpans.delete(input.tool_use_id);
      }
      return { continue: true };
    }] }],
    PostToolUseFailure: [{ hooks: [async (input) => {
      const span = toolSpans.get(input.tool_use_id);
      if (span) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: input.error });
        span.end();
        toolSpans.delete(input.tool_use_id);
      }
      return { continue: true };
    }] }],
    SubagentStart: [{ hooks: [async (input) => {
      const ctx = activeParentCtx || otelContext.active();
      const span = tracer.startSpan(`invoke_agent ${input.agent_type}`, {
        kind: SpanKind.INTERNAL,
        attributes: {
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.agent.id": input.agent_id,
          "gen_ai.agent.name": input.agent_type,
        },
      }, ctx);
      agentSpans.set(input.agent_id, span);
      return { continue: true };
    }] }],
    SubagentStop: [{ hooks: [async (input) => {
      const span = agentSpans.get(input.agent_id);
      if (span) { span.setStatus({ code: SpanStatusCode.OK }); span.end(); agentSpans.delete(input.agent_id); }
      return { continue: true };
    }] }],
  };
}

app.ws("/ws", (ws) => {
  let currentQuery = null;

  ws.on("message", async (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type !== "prompt") return;

    const sessionSpan = tracer.startSpan("invoke_agent claude-code", {
      kind: SpanKind.INTERNAL,
      attributes: {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": "claude-code",
        "gen_ai.provider.name": "anthropic",
        "gen_ai.request.model": process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || "claude-opus-4-6-v1",
      },
    });
    activeParentCtx = trace.setSpan(otelContext.active(), sessionSpan);

    let turnCount = 0;

    try {
      currentQuery = query({
        prompt: msg.prompt,
        options: {
          model: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || "claude-opus-4-6-v1",
          systemPrompt: { type: "preset", preset: "claude_code" },
          tools: { type: "preset", preset: "claude_code" },
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          maxTurns: 20,
          hooks: createHooks(),
          cwd: process.env.HOME || "/home/ec2-user",
        },
      });

      for await (const message of currentQuery) {
        if (message.type === "assistant") {
          turnCount++;
          const ctx = activeParentCtx;
          const llmSpan = tracer.startSpan(`chat ${message.message.model || "unknown"}`, {
            kind: SpanKind.CLIENT,
            attributes: {
              "gen_ai.operation.name": "chat",
              "gen_ai.provider.name": "anthropic",
              "gen_ai.request.model": process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || "claude-opus-4-6-v1",
              "gen_ai.response.model": message.message.model || "",
              "gen_ai.response.id": message.message.id || "",
              "gen_ai.response.finish_reasons": JSON.stringify([message.message.stop_reason || "unknown"]),
              "gen_ai.usage.input_tokens": message.message.usage?.input_tokens || 0,
              "gen_ai.usage.output_tokens": message.message.usage?.output_tokens || 0,
              "gen_ai.usage.cache_read.input_tokens": message.message.usage?.cache_read_input_tokens || 0,
              "gen_ai.usage.cache_creation.input_tokens": message.message.usage?.cache_creation_input_tokens || 0,
            },
          }, ctx);

          for (const block of message.message.content) {
            if (block.type === "text") {
              ws.send(JSON.stringify({ type: "text", content: block.text }));
            } else if (block.type === "tool_use") {
              ws.send(JSON.stringify({ type: "tool_use", tool: block.name, input: JSON.stringify(block.input).slice(0, 200) }));
            }
          }
          llmSpan.end();

        } else if (message.type === "result") {
          sessionSpan.setAttribute("gen_ai.usage.input_tokens", message.usage?.input_tokens || 0);
          sessionSpan.setAttribute("gen_ai.usage.output_tokens", message.usage?.output_tokens || 0);
          ws.send(JSON.stringify({ type: "result", cost: message.total_cost_usd, turns: message.num_turns, duration_ms: message.duration_ms }));
        }
      }
      sessionSpan.setStatus({ code: SpanStatusCode.OK });
    } catch (err) {
      sessionSpan.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      ws.send(JSON.stringify({ type: "error", message: err.message }));
    } finally {
      sessionSpan.end();
      activeParentCtx = null;
      currentQuery = null;
    }
  });

  ws.on("close", () => { if (currentQuery?.abort) currentQuery.abort(); });
});

const port = process.env.PORT || 8082;
app.listen(port, "0.0.0.0", () => console.log(`Claude Code Traced UI on http://0.0.0.0:${port}`));
