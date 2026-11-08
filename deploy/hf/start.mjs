import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";

const PORT = Number(process.env.PORT ?? 7860);
const T = { web: 3000, orch: 4000, office: 3200 };
const sh = (name, cmd, args, cwd, env = {}) => {
  const p = spawn(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
  p.on("exit", (c) => { console.log(`[${name}] exited ${c}`); process.exit(c ?? 1); });
};

sh("orchestrator", "npx", ["tsx", "src/index.ts"], "apps/orchestrator", { ORCHESTRATOR_PORT: String(T.orch) });
sh("web", "npx", ["next", "start", "-p", String(T.web), "-H", "127.0.0.1"], "apps/web");
sh("office", "npx", ["vite", "--port", String(T.office), "--host", "127.0.0.1", "--base", "/office/"], "services/pixel-agents/webview-ui");

const hits = new Map();
const LIMITED = /^\/orch\/(chat|agents|runs|world\/chat|world\/god|subjects)/;
const limited = (req) => {
  if (req.method !== "POST" || !LIMITED.test(req.url)) return false;
  const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress).split(",")[0].trim();
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > Number(process.env.RATE_LIMIT_PER_MIN ?? 20);
};

const route = (url) => {
  if (url === "/orch" || url.startsWith("/orch/")) return { port: T.orch, path: url.slice(5) || "/" };
  if (url.startsWith("/office")) return { port: T.office, path: url };
  return { port: T.web, path: url };
};

const server = http.createServer((req, res) => {
  if (limited(req)) { res.writeHead(429, { "content-type": "application/json" }); return res.end('{"error":"rate limit: slow down"}'); }
  const { port, path } = route(req.url);
  const up = http.request({ host: "127.0.0.1", port, path, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${port}` } }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end("upstream starting…"); });
  res.on("close", () => up.destroy());
  req.pipe(up);
});

server.on("upgrade", (req, socket, head) => {
  const { port, path } = route(req.url);
  const up = net.connect(port, "127.0.0.1", () => {
    const lines = [`${req.method} ${path} HTTP/1.1`, ...Object.entries({ ...req.headers, host: `127.0.0.1:${port}` }).map(([k, v]) => `${k}: ${v}`), "", ""];
    up.write(lines.join("\r\n"));
    up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});

server.listen(PORT, "0.0.0.0", () => console.log(`gateway on :${PORT}`));
