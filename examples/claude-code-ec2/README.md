# Claude Code + Observability Stack on EC2

Deploys an EC2 instance with Claude Code and the full observability stack pre-configured. Claude Code's OpenTelemetry telemetry (metrics + logs/events) flows through the OTel Collector into OpenSearch and Prometheus automatically.

## What Gets Deployed

- **EC2 instance** (m5.xlarge, 16GB RAM) with Amazon Linux 2023
- **Docker + Docker Compose** with the observability stack running
- **Claude Code** with OTLP telemetry pre-configured to `localhost:4317`
- **Security group** allowing SSH, OpenSearch Dashboards (5601), and Prometheus (9090)

## Prerequisites

- AWS CLI configured with credentials
- Node.js 18+
- An EC2 key pair in your target region

## Deploy

```bash
cd examples/claude-code-ec2
npm install
npx cdk deploy \
  --parameters KeyPairName=your-key-pair \
  --parameters MyIp=$(curl -s ifconfig.me)/32
```

## Use

After deploy (~5 min for user-data to finish):

```bash
# SSH in and run Claude Code (telemetry env vars are pre-loaded)
ssh ec2-user@<public-ip>
claude

# Or directly
ssh -t ec2-user@<public-ip> claude
```

Access dashboards from your browser:
- **OpenSearch Dashboards**: `http://<public-ip>:5601` (admin / My_password_123!@#)
- **Prometheus**: `http://<public-ip>:9090`

## What You'll See

**In OpenSearch** (Discover → log analytics index):
- `claude_code.user_prompt` — every prompt with content (if `OTEL_LOG_USER_PROMPTS=1`)
- `claude_code.tool_result` — tool executions with duration, bash commands, success/failure
- `claude_code.api_request` — model calls with token counts, cost, latency
- All correlated by `prompt.id`

**In Prometheus**:
- `claude_code_token_usage` — input/output/cache tokens by model
- `claude_code_cost_usage` — cost per session
- `claude_code_session_count`, `claude_code_lines_of_code_count`, `claude_code_commit_count`

## Teardown

```bash
npx cdk destroy
```
