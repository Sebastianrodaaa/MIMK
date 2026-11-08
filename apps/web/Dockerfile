FROM node:20-slim
WORKDIR /app
COPY package*.json ./
COPY apps/web ./apps/web
RUN npm install --workspace apps/web --include-workspace-root=false
EXPOSE 3000
CMD ["npm", "run", "dev", "-w", "apps/web"]
