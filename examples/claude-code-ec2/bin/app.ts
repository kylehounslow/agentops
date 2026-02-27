#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { ClaudeCodeObservabilityStack } from "../lib/stack";

const app = new cdk.App();
new ClaudeCodeObservabilityStack(app, "ClaudeCodeObservabilityStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
