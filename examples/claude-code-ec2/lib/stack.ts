import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

export class ClaudeCodeObservabilityStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const keyPairName = new cdk.CfnParameter(this, "KeyPairName", {
      type: "String",
      description: "EC2 key pair name for SSH access",
    });

    const myIp = new cdk.CfnParameter(this, "MyIp", {
      type: "String",
      description: "Your IP address in CIDR notation (e.g. 1.2.3.4/32)",
      default: "0.0.0.0/0",
    });

    const instanceType = new cdk.CfnParameter(this, "InstanceType", {
      type: "String",
      default: "m5.xlarge",
      description: "EC2 instance type (needs >= 16GB RAM)",
    });

    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: "Public",
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    });

    const sg = new ec2.SecurityGroup(this, "SG", {
      vpc,
      description: "Claude Code Observability Stack",
    });
    sg.addIngressRule(
      ec2.Peer.ipv4(myIp.valueAsString),
      ec2.Port.tcp(22),
      "SSH"
    );
    sg.addIngressRule(
      ec2.Peer.ipv4(myIp.valueAsString),
      ec2.Port.tcp(5601),
      "OpenSearch Dashboards"
    );
    sg.addIngressRule(
      ec2.Peer.ipv4(myIp.valueAsString),
      ec2.Port.tcp(9090),
      "Prometheus"
    );
    sg.addIngressRule(
      ec2.Peer.ipv4(myIp.valueAsString),
      ec2.Port.tcp(8080),
      "Claude Code Web UI"
    );

    const role = new iam.Role(this, "InstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "AmazonSSMManagedInstanceCore"
        ),
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "AmazonBedrockFullAccess"
        ),
      ],
    });

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      "set -ex",

      // Install Docker
      "dnf install -y docker git",
      "systemctl enable --now docker",
      "usermod -aG docker ec2-user",

      // Docker Compose plugin
      "mkdir -p /usr/local/lib/docker/cli-plugins",
      "curl -SL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64 -o /usr/local/lib/docker/cli-plugins/docker-compose",
      "chmod +x /usr/local/lib/docker/cli-plugins/docker-compose",

      // Node.js + Claude Code
      "curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -",
      "dnf install -y nodejs",
      "npm install -g @anthropic-ai/claude-code",
      "npm install -g claude-code-webui",

      // LiteLLM proxy for tracing
      "dnf install -y python3-pip",
      "pip3 install 'litellm[proxy]' python-multipart opentelemetry-api opentelemetry-sdk opentelemetry-exporter-otlp",

      // Nginx for auth proxy in front of webui
      "dnf install -y nginx httpd-tools",
      'htpasswd -cb /etc/nginx/.htpasswd admin "My_password_123!@#"',
      `cat > /etc/nginx/conf.d/claude-code.conf << 'NGINXCONF'
server {
    listen 8080;
    auth_basic "Claude Code Web UI";
    auth_basic_user_file /etc/nginx/.htpasswd;
    location / {
        proxy_pass http://127.0.0.1:8081;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }
}
NGINXCONF`,
      "systemctl enable --now nginx",

      // Clone and start observability stack
      "su - ec2-user -c 'git clone https://github.com/opensearch-project/observability-stack.git /home/ec2-user/observability-stack'",
      // Disable example services to save memory
      "sed -i 's/^INCLUDE_COMPOSE_EXAMPLES/#INCLUDE_COMPOSE_EXAMPLES/' /home/ec2-user/observability-stack/.env",
      "su - ec2-user -c 'cd /home/ec2-user/observability-stack && docker compose up -d'",

      // LiteLLM config for Bedrock + OTel tracing
      `su - ec2-user -c 'cat > ~/litellm-config.yaml << LITELLM
model_list:
  - model_name: claude-opus-4-6-v1
    litellm_params:
      model: bedrock/us.anthropic.claude-opus-4-6-v1
      aws_region_name: us-west-2
  - model_name: claude-sonnet-4-5-20250929
    litellm_params:
      model: bedrock/us.anthropic.claude-sonnet-4-5-20250929-v2:0
      aws_region_name: us-west-2
  - model_name: claude-haiku-4-5-20251001
    litellm_params:
      model: bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0
      aws_region_name: us-west-2
litellm_settings:
  callbacks: ["otel"]
  master_key: "sk-litellm-observability-demo"
LITELLM'`,

      // Start LiteLLM proxy
      `su - ec2-user -c 'OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 OTEL_EXPORTER_OTLP_PROTOCOL=http/json USE_OTEL_LITELLM_REQUEST_SPAN=true nohup litellm --config ~/litellm-config.yaml --port 4001 > ~/litellm.log 2>&1 &'`,

      // Start Claude Code Web UI (behind nginx auth)
      `su - ec2-user -c 'nohup claude-code-webui --host 127.0.0.1 --port 8081 > ~/webui.log 2>&1 &'`,

      // Write Claude Code telemetry env vars to profile
      `cat >> /home/ec2-user/.bashrc << 'TELEMETRY'

# Claude Code → Amazon Bedrock
export CLAUDE_CODE_USE_BEDROCK=1
export ANTHROPIC_MODEL=us.anthropic.claude-opus-4-6-v1
export AWS_REGION=us-west-2

# Claude Code OpenTelemetry → Observability Stack
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=grpc
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
export OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=cumulative
export OTEL_METRIC_EXPORT_INTERVAL=10000
export OTEL_LOG_USER_PROMPTS=1
export OTEL_LOG_TOOL_DETAILS=1
TELEMETRY`
    );

    const instance = new ec2.Instance(this, "Instance", {
      vpc,
      instanceType: new ec2.InstanceType(instanceType.valueAsString),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: sg,
      role,
      userData,
      keyPair: ec2.KeyPair.fromKeyPairName(
        this,
        "KeyPair",
        keyPairName.valueAsString
      ),
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: ec2.BlockDeviceVolume.ebs(50, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
          }),
        },
      ],
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    new cdk.CfnOutput(this, "InstancePublicIp", {
      value: instance.instancePublicIp,
    });
    new cdk.CfnOutput(this, "DashboardsUrl", {
      value: `http://${instance.instancePublicIp}:5601`,
    });
    new cdk.CfnOutput(this, "PrometheusUrl", {
      value: `http://${instance.instancePublicIp}:9090`,
    });
    new cdk.CfnOutput(this, "ClaudeCodeWebUI", {
      value: `http://${instance.instancePublicIp}:8080 (admin / My_password_123!@#)`,
    });
    new cdk.CfnOutput(this, "SshCommand", {
      value: `ssh ec2-user@${instance.instancePublicIp}`,
    });
    new cdk.CfnOutput(this, "ClaudeCodeCommand", {
      value: `ssh -t ec2-user@${instance.instancePublicIp} claude`,
    });
  }
}
