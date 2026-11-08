import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT ?? 7860);
const T = {
  web: Number(process.env.T_WEB ?? 3000),
  orch: Number(process.env.T_ORCH ?? 4000),
  office: Number(process.env.T_OFFICE ?? 3200),
};
const sh = (name, cmd, args, cwd, env = {}) => {
  const p = spawn(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
  p.on("exit", (c) => { console.log(`[${name}] exited ${c}`); process.exit(c ?? 1); });
};

if (process.env.SKIP_SPAWN !== "1") {
  sh("orchestrator", "npx", ["tsx", "src/index.ts"], "apps/orchestrator", { ORCHESTRATOR_PORT: String(T.orch) });
  sh("web", "npx", ["next", "start", "-p", String(T.web), "-H", "127.0.0.1"], "apps/web");
  sh("office", "npx", ["vite", "--port", String(T.office), "--host", "127.0.0.1", "--base", "/office/"], "services/pixel-agents/webview-ui");
}

const hits = new Map();
const LIMITED = /^\/orch\/(chat|agents|runs|world\/chat|world\/god|subjects|twins)/;
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

const cookieValue = (req, name) => {
  const m = String(req.headers.cookie ?? "").match(new RegExp(`(?:^|;\\s*)${name}=([^;\\s]+)`));
  return m?.[1];
};
// Visitor identity: the gateway is the only trusted source — inbound
// x-visitor-id / x-visitor-ip headers are always overwritten so clients
// can't spoof another visitor or inflate someone else's quota.
const visitorHeaders = (req) => {
  const ip = String(
    req.headers["fly-client-ip"] ?? req.headers["x-forwarded-for"] ?? req.socket.remoteAddress
  ).split(",")[0].trim();
  let vid = cookieValue(req, "mimk_vid");
  const fresh = !vid;
  if (!vid) vid = randomUUID();
  return {
    vid,
    headers: {
      ...req.headers,
      "x-visitor-id": vid,
      "x-visitor-ip": ip,
    },
    // third-party cookie: the app is iframed on noemtech.com, so SameSite=None
    setCookie: fresh ? `mimk_vid=${vid}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=None` : undefined,
  };
};

const server = http.createServer((req, res) => {
  if (limited(req)) { res.writeHead(429, { "content-type": "application/json" }); return res.end('{"error":"rate limit: slow down"}'); }
  const { port, path } = route(req.url);
  const v = visitorHeaders(req);
  const up = http.request({ host: "127.0.0.1", port, path, method: req.method, headers: { ...v.headers, host: `127.0.0.1:${port}` } }, (r) => {
    const headers = { ...r.headers };
    if (v.setCookie)
      headers["set-cookie"] = headers["set-cookie"] ? [].concat(headers["set-cookie"], v.setCookie) : v.setCookie;
    res.writeHead(r.statusCode ?? 502, headers);
    r.pipe(res);
  });
  up.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end("upstream starting…"); });
  res.on("close", () => up.destroy());
  req.pipe(up);
});

server.on("upgrade", (req, socket, head) => {
  const { port, path } = route(req.url);
  const v = visitorHeaders(req);
  const up = net.connect(port, "127.0.0.1", () => {
    const lines = [`${req.method} ${path} HTTP/1.1`, ...Object.entries({ ...v.headers, host: `127.0.0.1:${port}` }).map(([k, v]) => `${k}: ${v}`), "", ""];
    up.write(lines.join("\r\n"));
    up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});

server.listen(PORT, "0.0.0.0", () => console.log(`gateway on :${PORT}`));
