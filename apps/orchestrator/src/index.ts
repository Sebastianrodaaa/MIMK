import Docker from "dockerode";
import { existsSync, readFileSync } from "node:fs";
import { createApp } from "./app.js";
import { createDb } from "./db.js";
import { loadFixtureDir, MirofishBackend, mirofishLazy, type SimBackend } from "./sim.js";
import { reattachCollectors } from "./collector.js";
import { createClient, type HClient } from "./hagents.js";
import { pollHRun } from "./hcollector.js";

const envFile = "../../.env";
if (existsSync(envFile))
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith("#") && !(m[1] in process.env))
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
import type { ChatFn } from "@mimk/twin";

const port = Number(process.env.ORCHESTRATOR_PORT ?? 4000);
const db = createDb(process.env.DB_PATH ?? "./data/mimk.db");
const docker = new Docker();

const fixturesDir = process.env.FIXTURES_DIR;   // no default: fixture-free world
const fixtures = fixturesDir && existsSync(fixturesDir) ? loadFixtureDir(fixturesDir) : undefined;
for (const s of fixtures?.subjects ?? []) {
  if (!db.getSubject(s.id)) db.addSubject(s);
}
for (const p of fixtures?.personas ?? []) db.seedTwin(p);
for (const d of fixtures?.dossiers ?? []) db.saveDossier(d);

const base = process.env.TWIN_MODEL_BASE_URL || process.env.MODEL_BASE_URL;
const name = process.env.TWIN_MODEL_NAME || process.env.MODEL_NAME || "holo";
const key = process.env.TWIN_MODEL_API_KEY || process.env.MODEL_API_KEY || "";
const effort = process.env.TWIN_MODEL_REASONING_EFFORT ?? process.env.MODEL_REASONING_EFFORT;
const chat: ChatFn | undefined =
  base && process.env.OFFLINE !== "1"
    ? async (messages) => {
        const res = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: name, messages, temperature: 0.7,
            ...(effort ? { reasoning_effort: effort } : {}),
          }),
        });
        const j: any = await res.json();
        return j.choices?.[0]?.message?.content ?? "";
      }
    : undefined;

const haiKey = process.env.HAI_API_KEY || process.env.MODEL_API_KEY;
const hClient: HClient | undefined = haiKey
  ? createClient({
      baseUrl: process.env.HAI_AGENTS_BASE_URL ?? "https://agp.eu.hcompany.ai/api/v2",
      apiKey: haiKey,
      agent: process.env.HAI_AGENT ?? "h/web-surfer-flash",
      maxSteps: Number(process.env.HAI_MAX_STEPS ?? 25),
      maxTimeS: Number(process.env.HAI_MAX_TIME_S ?? 240),
    })
  : undefined;
const runBackend =
  (process.env.RUN_BACKEND as "docker" | "h" | undefined) ??
  (hClient ? "h" : "docker");
console.log(`backend=${runBackend} model=${name} key=${haiKey ? "set" : "unset"}`);

let simBackend: SimBackend | undefined = undefined;
let simStatus: Record<string, unknown> = { sim: "none" };
if (process.env.MIROFISH_URL) {
  const mf = new MirofishBackend(process.env.MIROFISH_URL);
  if (mirofishLazy()) {
    // lazy mode: no boot probe — the backend may be scaled to zero and is
    // woken by epoch requests (cold start 30-90s is handled per-epoch)
    simBackend = mf;
    simStatus = { sim: "mirofish", mirofish: process.env.MIROFISH_URL, mirofishMode: "lazy" };
  } else {
    try {
      const r = await fetch(`${process.env.MIROFISH_URL}/api/simulation/list`, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      if (!process.env.ZEP_API_KEY && !process.env.MIROFISH_ZEP_OK)
        throw new Error("ZEP_API_KEY missing (get one at app.getzep.com)");
      simBackend = mf;
      simStatus = { sim: "mirofish", mirofish: process.env.MIROFISH_URL };
    } catch (e: any) {
      simStatus = { sim: "none", simReason: `mirofish unavailable: ${String(e?.message ?? e)}` };
    }
  }
}

createApp({
  db, docker,
  agentImage: process.env.AGENT_IMAGE ?? "mimk-agent",
  modelEnv: {
    MODEL_BASE_URL: process.env.MODEL_BASE_URL ?? "",
    MODEL_NAME: process.env.MODEL_NAME ?? "holo",
    MODEL_API_KEY: process.env.MODEL_API_KEY ?? "",
    MODEL_REASONING_EFFORT: process.env.MODEL_REASONING_EFFORT,
  },
  maxSteps: process.env.MAX_STEPS,
  maxParallel: Number(process.env.MAX_PARALLEL ?? 4),
  chat,
  fixtures,
  simBackend,
  hClient,
  runBackend,
  agentBackend: process.env.AGENT_BACKEND === "h" ? "h" : process.env.AGENT_BACKEND === "none" ? "none" : "docker",
  director: { autostart: process.env.DIRECTOR !== "off", intervalMs: Number(process.env.DIRECTOR_INTERVAL_MS ?? 45000) },
  status: () => simStatus,
  society: process.env.SOCIETY === "off" ? false : { autostart: true },
  epochs: process.env.EPOCHS === "off" ? false : { autostart: true },
  ...(process.env.DEMO_MODE === "1" ? {
    demo: {
      ipCap: Number(process.env.DEMO_IP_CAP ?? 3),
      maxTwins: Number(process.env.DEMO_MAX_TWINS ?? 40),
      chatMsgCap: Number(process.env.DEMO_CHAT_MSG_CAP ?? 30),
      adminToken: process.env.DEMO_ADMIN_TOKEN,
    },
  } : {}),
}).listen(port, () => {
  console.log(`orchestrator on :${port}`);
  void reattachCollectors(docker, db);
  if (hClient)
    for (const r of db.listRuns())
      if (r.backend === "h" && r.status === "running") void pollHRun(r, hClient, db);
});
