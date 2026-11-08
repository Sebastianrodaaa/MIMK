import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const env = { ...process.env };
if (existsSync(".env"))
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !l.trim().startsWith("#") && !(m[1] in env)) env[m[1]] = m[2];
  }

const hasKey = !!(env.HAI_API_KEY || env.MODEL_API_KEY);
const mode = env.OFFLINE === "1" ? "offline" : "live";
const backend = env.RUN_BACKEND ?? (hasKey ? "h" : "docker");
const sim = env.MIROFISH_URL ? "mirofish" : "replay";

console.log(`
  MIMK dev:all
  ─────────────────────────────────────────
  orchestrator : http://localhost:${env.ORCHESTRATOR_PORT ?? 4000}
  web          : http://localhost:3000 (or :3001 if 3000 is busy)
  mode: ${mode} | run backend: ${backend} | sim: ${sim} | models: ${hasKey ? "set" : "unset"}
  ─────────────────────────────────────────
`);

for (const [name, dir] of [["orchestrator", "apps/orchestrator"], ["web", "apps/web"]]) {
  const p = spawn("npm", ["run", "dev"], { cwd: dir, env, stdio: "inherit" });
  p.on("exit", (c) => console.log(`[${name}] exited ${c}`));
}
if (existsSync("services/pixel-agents/node_modules")) {
  const p = spawn("npx", ["vite", "--port", "3200", "--host", "127.0.0.1"], { cwd: "services/pixel-agents/webview-ui", env, stdio: "inherit" });
  p.on("exit", (c) => console.log(`[pixel-office] exited ${c}`));
}
