FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /home/node/app
COPY --chown=node:node . .
RUN mkdir -p apps/orchestrator/data && chown -R node:node /home/node
USER node
RUN npm install --no-audit --no-fund
RUN cd services/pixel-agents && npm install --no-audit --no-fund --ignore-scripts -w webview-ui
ENV NEXT_PUBLIC_ORCHESTRATOR_URL=/orch NEXT_PUBLIC_OFFICE_URL=/office/
RUN npm run build -w @mimk/web
ENV PORT=7860 AGENT_BACKEND=none NEXT_TELEMETRY_DISABLED=1 DB_PATH=/home/node/app/apps/orchestrator/data/mimk.db
EXPOSE 7860
CMD ["node", "deploy/start.mjs"]
