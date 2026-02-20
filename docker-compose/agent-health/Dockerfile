# Copyright OpenSearch Contributors
# SPDX-License-Identifier: Apache-2.0

FROM node:20-slim AS build

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN git clone --depth 1 https://github.com/opensearch-project/agent-health.git .
RUN npm install
RUN npm run build:all

FROM node:20-slim

WORKDIR /app
COPY --from=build /app /app

EXPOSE 4001
CMD ["node", "server/dist/index.js"]
