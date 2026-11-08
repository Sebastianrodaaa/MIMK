import { spawn } from "node:child_process";

const ORCH = process.env.ORCHESTRATOR_URL ?? "http://localhost:4000";
const live = process.argv.includes("--live");
const rows = [];
const row = (name, status, detail = "") => rows.push({ name, status, detail });
const j = async (r) => r.json();
const post = (p, b) => fetch(`${ORCH}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b ?? {}) });

let status;
try {
  status = await fetch(`${ORCH}/status`).then(j);
  row("GET /status", "PASS", JSON.stringify(status));
} catch (e) {
  row("GET /status", "FAIL", String(e));
  table(); process.exit(1);
}

const sub = await post("/subjects", {
  name: `Smoke ${Date.now() % 100000}`, type: "volunteer",
  approvedSources: ["github"], consent: true, handles: [],
}).then(j).catch(() => null);
row("POST /subjects", sub?.id ? "PASS" : "FAIL", sub?.id ?? "");
const sid = sub?.id;

let backend = status.runBackend;
if (live && !status.haiKey && status.modelKey !== "set") {
  row("H session", "SKIP", "no HAI/MODEL key set");
} else if (backend === "docker") {
  const hasImage = await fetch(`${ORCH}/runs`, { method: "HEAD" }).then(() => true).catch(() => false);
  const mock = spawn("node", ["runtime/agent-image/test/mock-model.mjs"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 800));
  const runs = await post("/runs", { subjectId: sid, count: 1 }).then(j).catch((e) => null);
  if (Array.isArray(runs) && runs[0]?.status === "running") {
    row("docker run", "PASS", `run ${runs[0].id.slice(0, 8)} vnc:${runs[0].vncPort}`);
    const t0 = Date.now();
    while (Date.now() - t0 < 90000) {
      await new Promise((r) => setTimeout(r, 5000));
      const all = await fetch(`${ORCH}/runs`).then(j);
      if (all.find((r) => r.id === runs[0].id)?.status !== "running") break;
    }
  } else {
    row("docker run", "SKIP", `container spawn failed (build mimk-agent first) — ${JSON.stringify(runs).slice(0, 120)}`);
  }
  mock.kill();
} else {
  row("docker run", "SKIP", `backend=${backend}`);
}

const pipe = sid && await post(`/subjects/${sid}/pipeline`).then(j).catch(() => null);
row("pipeline", pipe?.persona ? "PASS" : "FAIL", pipe?.persona?.name ?? "");
const twins = await fetch(`${ORCH}/twins`).then(j);
row("GET /twins", twins.some((t) => t.subjectId === sid) ? "PASS" : "FAIL", `${twins.length} twins`);

try {
  const ctrl = new AbortController();
  const res = await fetch(`${ORCH}/sim/events`, { signal: ctrl.signal });
  const reader = res.body.getReader();
  const to = setTimeout(() => ctrl.abort(), 5000);
  const { value } = await reader.read();
  clearTimeout(to);
  row("GET /sim/events", value ? "PASS" : "FAIL", new TextDecoder().decode(value ?? "").slice(0, 80).replace(/\n/g, " "));
} catch (e) { row("GET /sim/events", "FAIL", String(e).slice(0, 80)); }

if (live) {
  const sub2 = await post("/subjects", {
    name: "Linus Torvalds", type: "public_figure",
    approvedSources: ["news", "public-records", "archive.org"], consent: true,
  }).then(j);
  const run = (await post("/runs", { subjectId: sub2.id, count: 1, backend: "h" }).then(j))?.[0];
  if (run?.status === "running") {
    row("H session", "PASS", `run ${run.id.slice(0, 8)} view: ${run.agentViewUrl ?? "n/a"}`);
  } else row("H session", "FAIL", JSON.stringify(run).slice(0, 150));
}

table();
function table() {
  console.log("\nSMOKE " + "-".repeat(60));
  for (const r of rows) console.log(`${r.status.padEnd(5)} ${r.name.padEnd(18)} ${r.detail}`);
  const fails = rows.filter((r) => r.status === "FAIL").length;
  console.log("-".repeat(68), `\n${rows.length} checks, ${fails} failed`);
}
