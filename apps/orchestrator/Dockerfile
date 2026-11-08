FROM node:20-slim
WORKDIR /app
COPY package*.json ./
COPY packages/shared ./packages/shared
COPY apps/orchestrator ./apps/orchestrator
RUN npm install --workspace apps/orchestrator --include-workspace-root=false
EXPOSE 4000
CMD ["npm", "run", "dev", "-w", "apps/orchestrator"]
