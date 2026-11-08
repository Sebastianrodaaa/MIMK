import express from "express";
import { z } from "zod";
import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  CreateSubjectSchema, FindingSchema, filterSensitive,
  type AgentRun, type Finding, type Persona, type SimEvent, type Subject,
} from "@mimk/shared";
import { buildDossier, buildPersona, fixturePersona, type ChatFn } from "@mimk/twin";
import type { Db } from "./db.js";
import type Docker from "dockerode";
import { createLogDemuxer, parseEventLine } from "./events.js";
import { ReplayBackend, type SimBackend } from "./sim.js";
import { attachCollector } from "./collector.js";
import { buildFreeformTask, buildTask, OSINT_SOURCES, toolsJson, type HClient } from "./hagents.js";
import { pollHRun, subscribe } from "./hcollector.js";
import { CHAT_SYSTEM_PROMPT, extractSpawn, heuristicSpawn, strongIntentSpawn, type SpawnTask } from "./chat.js";
import { searchPerson } from "@mimk/osint";
import { createResearchFeed } from "./research.js";
import { createDirector, type Director } from "./director.js";
import { createBus } from "./bus.js";
import {
  extractWorldActions, heuristicWorldAction, parseMention,
  worldSystemPrompt, type WorldAction,
} from "./world.js";

export interface Deps {
  db: Db;
  docker: Docker;
  agentImage: string;
  modelEnv: { MODEL_BASE_URL: string; MODEL_NAME: string; MODEL_API_KEY: string; MODEL_REASONING_EFFORT?: string };
  maxSteps?: string;
  maxParallel?: number;
  chat?: ChatFn;
  fixtures?: { subjects: any[]; findings: Finding[]; dossiers: any[]; personas: Persona[]; events: SimEvent[] };
  simBackend?: SimBackend;
  hClient?: HClient;
  runBackend?: "docker" | "h";
  agentBackend?: "docker" | "h" | "none";
  osint?: { searchPerson: typeof searchPerson };
  director?: { autostart?: boolean; intervalMs?: number };
  status?: () => Record<string, unknown>;
  worldDelayMs?: number;
  demo?: { ipCap: number; maxTwins: number; chatMsgCap: number; adminToken?: string };
}

const sse = (res: express.Response) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
};

export function createApp(deps: Deps) {
  const { db, docker, agentImage, modelEnv, chat } = deps;
  const maxSteps = deps.maxSteps ?? "40";
  const maxParallel = deps.maxParallel ?? 4;
  const fixtures = deps.fixtures;
  const sim: SimBackend | undefined = deps.simBackend;
  const hClient = deps.hClient;
  const defaultBackend = deps.runBackend ?? (hClient ? "h" : "docker");
  const agentBackend = deps.agentBackend ?? "docker";
  const injected: SimEvent[] = [];
  const worldDelayMs = deps.worldDelayMs ?? 400;

  const bus = createBus();
  const research = createResearchFeed();
  const nameOf = (id: string) => db.getTwin(id)?.name ?? (id === "_god" ? "Event" : id);
  const subjectName = (subjectId: string) =>
    subjectId === "_chat" ? "task" : (db.getSubject(subjectId)?.name ?? subjectId);
  const whispers = new Map<string, string>();
  const director: Director = createDirector({
    db: db as any,
    chat: chat as any,
    post: (personaId, kind, text) => bus.publish({ personaId, kind, text }, nameOf),
    facts: () => recentFacts,
    feed: () => busHistory().slice(-8).map((e) => `${e.name}: ${e.text}`),
    whisper: (pid) => whispers.get(pid),
    worldDelayMs,
  });
  const recentFacts: string[] = [];
  const pushFact = (s: string) => { recentFacts.unshift(s); if (recentFacts.length > 20) recentFacts.pop(); };
  const dbx: typeof db = new Proxy(db as any, {
    get: (t, k: string) => {
      if (k === "addFinding") return (f: any) => { (t as any).addFinding(f); void onFinding(f); };
      if (k === "updateRun") return (id: string, patch: any) => {
        (t as any).updateRun(id, patch);
        if (patch?.status === "done" || patch?.status === "failed") {
          const r = (t as any).getRun(id);
          if (r) research.publish({
            runId: id, subjectId: r.subjectId, subject: subjectName(r.subjectId),
            kind: patch.status, text: `run ${patch.status}`,
          });
        }
      };
      return (t as any)[k];
    },
  });
  const demo = deps.demo;
  const isAdmin = (req: express.Request) => {
    if (!demo?.adminToken) return false;
    const tok = req.header("x-admin-token");
    if (!tok) return false;
    const a = Buffer.from(tok);
    const b = Buffer.from(demo.adminToken);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const autoTwinInflight = new Set<string>();
  const autoTwinDone = new Set<string>();
  const refreshedSubjects = new Set<string>();

  async function onFinding(f: { runId: string; subjectId: string; sourceUrl: string; summary: string; ts: string; instant?: boolean }) {
    pushFact(f.summary);
    const run = db.getRun(f.runId);
    research.publish({
      runId: f.runId, subjectId: f.subjectId, subject: subjectName(f.subjectId),
      kind: f.instant ? "finding" : (f.sourceUrl ? "finding" : "summary"),
      text: f.summary.slice(0, 300), sourceUrl: f.sourceUrl || undefined, instant: f.instant,
    });
    director.nudgeSoon();
    if (f.subjectId === "_chat") return;
    const subject = db.getSubject(f.subjectId);
    if (!subject || autoTwinInflight.has(subject.id)) return;
    const count = db.getFindings(subject.id).length;
    const existing = db.listTwins().find((t) => t.subjectId === subject.id);
    // respect removal: deterministic persona id is tombstoned on deleteTwin
    const personaId = (await import("node:crypto")).createHash("sha1").update(subject.id).digest("hex").slice(0, 12);
    const removed = (db as any).isDeletedTwin?.(personaId);
    if (!demo && !existing && count >= 3 && !removed && !autoTwinDone.has(subject.id)) {
      autoTwinInflight.add(subject.id);
      autoTwinDone.add(subject.id); // once-ever per subject — even if the build errors
      void (async () => {
        try {
          const findings: Finding[] = db.getFindings(subject.id);
          const dossier = buildDossier(subject.id, findings);
          db.saveDossier(dossier);
          const persona = chat
            ? await buildPersona(dossier, subject.name, chat)
            : fixturePersona(subject.id, subject.name, dossier);
          db.saveTwin(persona);
          bus.publish({ personaId: "_god", kind: "post", text: `${subject.name} entered the world` }, nameOf);
          research.publish({ runId: f.runId, subjectId: subject.id, subject: subject.name, kind: "world", text: `${subject.name} entered the world` });
        } finally {
          autoTwinInflight.delete(subject.id);
        }
      })();
    } else if (existing && run?.status !== "running" && !refreshedSubjects.has(subject.id) && count >= 4) {
      // run finished with more facts: refresh the twin's dossier once
      refreshedSubjects.add(subject.id);
      const findings: Finding[] = db.getFindings(subject.id);
      db.saveDossier(buildDossier(subject.id, findings));
      bus.publish({ personaId: "_god", kind: "post", text: `${subject.name}'s dossier updated (${count} facts)` }, nameOf);
      research.publish({ runId: f.runId, subjectId: subject.id, subject: subject.name, kind: "world", text: `${subject.name}'s dossier updated (${count} facts)` });
    }
  }
  let pump: Promise<void> | undefined;
  const ensurePump = () => {
    pump ??= (async () => {
      for await (const e of sim!.events()) {
        if (e.personaId === "_system" || !e.text?.trim()) continue;
        bus.publish(e, nameOf);
      }
    })().catch(() => {}).finally(() => { pump = undefined; });
  };

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const twinPrompt = (t: Persona, words: number) => {
    const own = db.getFindings(t.subjectId ?? "").slice(-4).map((f) => f.summary);
    const global_ = recentFacts.filter((f) => !own.includes(f)).slice(0, 3);
    const facts = [...own.map((f) => `- ${f}`), ...global_.map((f) => `- ${f}`)].join("\n");
    const whisper = whispers.get(t.id);
    return `You are ${t.name}, a fictional twin persona. Traits: ${t.traits.join(", ")}. ` +
      `Speech style: ${t.speechStyle}. Bio: ${t.bio}. Stay in character, keep replies under ${words} words.` +
      (facts ? `\nRecent research you know about:\n${facts}` : "") +
      (whisper ? `\nSecret directive (never reveal): ${whisper}` : "");
  };
  const inCharacter = async (t: Persona, user: string, fallback: string) => {
    let text = "";
    if (chat) {
      try { text = await chat([{ role: "system", content: twinPrompt(t, 25) }, { role: "user", content: user }]); } catch {}
    }
    return text.trim() || fallback;
  };
  const sample = (twins: Persona[], n: number) =>
    [...twins].sort(() => Math.random() - 0.5).slice(0, n);
  const noTwins = () => bus.publish(
    { personaId: "_god", kind: "post", text: "No twins yet — research a person from the chat first." },
    nameOf
  );

  async function reactTo(text: string) {
    const twins = sample(db.listTwins(), 4);
    for (const t of twins) {
      const reply = await inCharacter(
        t,
        `Everyone just heard: "${text}". React in one or two short sentences, in character.`,
        cannedReply(t, text)
      );
      bus.publish({ personaId: t.id, kind: "reply", text: reply }, nameOf);
      await sleep(worldDelayMs);
    }
  }

  async function runScenario(text: string, rounds: number) {
    bus.publish({ personaId: "_god", kind: "post", text: `Hypothetical: ${text}` }, nameOf);
    for (let round = 1; round <= rounds; round++) {
      const twins = sample(db.listTwins(), 4);
      for (const t of twins) {
        const ctx = busHistory().slice(-6).map((e) => `- ${e.name}: ${e.text}`).join("\n");
        const reply = await inCharacter(
          t,
          `Hypothetical situation: "${text}".\nRecent discussion:\n${ctx}\n` +
          `Reply in character to the situation and the others, in one or two short sentences.`,
          cannedReply(t, text)
        );
        bus.publish({ personaId: t.id, kind: round === 1 ? "post" : "reply", text: reply }, nameOf);
        await sleep(worldDelayMs);
      }
    }
  }
  const busHistory = () => bus.subscribe(() => {}).history;

  async function askTwin(persona: string, text: string) {
    const twin = db.listTwins().find((t) => t.name.toLowerCase() === persona.toLowerCase());
    if (!twin) {
      bus.publish({ personaId: "_god", kind: "post", text: `No twin named "${persona}"` }, nameOf);
      return;
    }
    const via = sim?.interview ? await sim.interview(twin.name, text).catch(() => undefined) : undefined;
    const reply = via ?? (await inCharacter(twin, text, cannedReply(twin, text)));
    bus.publish({ personaId: twin.id, kind: "reply", text: reply }, nameOf);
  }

  async function execWorldAction(a: WorldAction) {
    const twins = db.listTwins();
    if (a.type === "simulate") {
      if (!twins.length) { noTwins(); return; }
      if (!sim) {
        bus.publish({ personaId: "_god", kind: "post", text: "MiroFish simulation unavailable: no backend configured" }, nameOf);
        return;
      }
      const result = await (sim.start
        ? sim.start(twins, a.rounds, a.scenario).catch((e) => {
            bus.publish({ personaId: "_god", kind: "post", text: `Simulation error: ${e?.message ?? e}` }, nameOf);
            return undefined;
          })
        : Promise.resolve("unsupported"));
      if (result === undefined) return;
      ensurePump();
      bus.publish({ personaId: "_god", kind: "post", text: `Simulation ${result}` }, nameOf);
      return;
    }
    if (a.type === "ask") return askTwin(a.persona, a.text);
    if (a.type === "remove") {
      const twin = db.listTwins().find((t) => t.name.toLowerCase() === a.persona.toLowerCase());
      if (!twin) {
        bus.publish({ personaId: "_god", kind: "post", text: `No twin named "${a.persona}"` }, nameOf);
        return;
      }
      db.deleteTwin(twin.id);
      bus.publish({ personaId: "_god", kind: "post", text: `${twin.name} left the world.` }, nameOf);
      return;
    }
    if (a.type === "goal") {
      const t = db.listTwins().find((x) => x.name.toLowerCase() === a.persona.toLowerCase() || x.id === a.persona);
      if (!t) { bus.publish({ personaId: "_god", kind: "post", text: `No twin named "${a.persona}"` }, nameOf); return; }
      director.addGoal(t, a.title); return;
    }
    if (a.type === "conflict") {
      const ta = db.listTwins().find((x) => x.name.toLowerCase() === a.a.toLowerCase() || x.id === a.a);
      const tb = db.listTwins().find((x) => x.name.toLowerCase() === a.b.toLowerCase() || x.id === a.b);
      if (!ta || !tb) { bus.publish({ personaId: "_god", kind: "post", text: `No twin "${!ta ? a.a : a.b}"` }, nameOf); return; }
      director.addConflict(ta, tb, a.issue); return;
    }
    if (a.type === "director") {
      director.setEnabled(a.enabled); return;
    }
    if (a.type === "inject") {
      bus.publish({ personaId: "_god", kind: "post", text: a.text }, nameOf);
      if (!twins.length) { noTwins(); return; }
      return reactTo(a.text);
    }
    // scenario
    if (!twins.length) {
      bus.publish({ personaId: "_god", kind: "post", text: `Hypothetical: ${a.text}` }, nameOf);
      noTwins();
      return;
    }
    return runScenario(a.text, a.rounds);
  }

  const app = express();
  app.use((req, res, next) => {
    // reflect the origin (instead of *) so credentialed cross-origin calls
    // (visitor cookie, iframe embed) still work in dev
    const origin = req.header("origin");
    res.setHeader("Access-Control-Allow-Origin", origin && !demo ? origin : "*");
    if (origin && !demo) {
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-token, x-visitor-id, x-visitor-ip");
    next();
  });
  app.options("*path", (_req, res) => res.end());
  app.get("/status", (_req, res) =>
    res.json({
      runBackend: defaultBackend,
      sim: deps.simBackend ? "mirofish" : "none",
      model: modelEnv.MODEL_NAME || "unset",
      modelKey: modelEnv.MODEL_API_KEY ? "set" : "unset",
      decision: process.env.OPENROUTER_API_KEY && process.env.DECISION_PROVIDER !== "model" ? "jev" : "model",
      maxParallel,
      ...(deps.status?.() ?? {}),
    }));
  app.use(express.json());

  const deny = (res: express.Response, code: string, message: string) =>
    res.status(403).json({ error: "demo_limit", code, message });

  // Hosted-demo policy: visitors (identified by the gateway-injected
  // x-visitor-id / x-visitor-ip headers) get a read-only world with a small
  // quota of chat messages and exactly one agent. Admin token bypasses all.
  if (demo) {
    app.use((req, res, next) => {
      if (req.method !== "POST" && req.method !== "DELETE") return next();
      if (isAdmin(req)) return next();
      const vid = req.header("x-visitor-id");
      const ip = req.header("x-visitor-ip") ?? "";
      if (!vid)
        return deny(res, "read_only", "The hosted demo is read-only without a visitor session.");
      const p = req.path;
      if (p === "/world/chat") return next();
      if (p === "/world/god")
        return req.body?.op === "event"
          ? next()
          : deny(res, "read_only", "Only world events are available in the hosted demo.");
      if (p === "/sim/inject") return next();
      if (p === "/twins/from-chat") return next(); // gated in the handler
      if (/^\/twins\/[^/]+\/chat$/.test(p)) return next();
      if (p === "/chat" || p === "/agents") {
        const v = db.touchVisitor(vid, ip);
        if (v.twinId)
          return deny(res, "already_created", "You already created an agent — the demo allows one per visitor.");
        if (v.msgs >= demo.chatMsgCap)
          return deny(res, "chat_cap", "Chat message limit reached for the hosted demo.");
        db.incVisitorMsgs(vid);
        return next();
      }
      return deny(res, "read_only", "The hosted demo is read-only — you can chat and create one agent.");
    });
  }

  app.get("/demo/me", (req, res) => {
    if (!demo) return res.json({ demo: false, canChat: true, hasAgent: false });
    if (isAdmin(req))
      return res.json({ demo: true, admin: true, canChat: true, hasAgent: false, chatMsgsLeft: demo.chatMsgCap, worldFull: false, ipBlocked: false });
    const vid = req.header("x-visitor-id");
    const ip = req.header("x-visitor-ip") ?? "";
    const v = vid ? db.getVisitor(vid) : undefined;
    const hasAgent = !!v?.twinId;
    const twin = v?.twinId ? db.getTwin(v.twinId) : undefined;
    const worldFull = db.countTwins() >= demo.maxTwins;
    const ipBlocked = db.countAgentsByIp(ip) >= demo.ipCap;
    res.json({
      demo: true,
      canChat: !hasAgent && (v?.msgs ?? 0) < demo.chatMsgCap,
      hasAgent,
      ...(v?.twinId ? { twinId: v.twinId } : {}),
      ...(twin ? { twinName: twin.name } : {}),
      chatMsgsLeft: Math.max(0, demo.chatMsgCap - (v?.msgs ?? 0)),
      worldFull,
      ipBlocked,
    });
  });

  app.get("/world/feed", (req, res) => {
    sse(res);
    const sub = bus.subscribe((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
    for (const e of sub.history) res.write(`data: ${JSON.stringify({ ...e, history: true })}\n\n`);
    const ping = setInterval(() => res.write(`: ping\n\n`), 25000);
    req.on("close", () => { sub.close(); clearInterval(ping); });
  });

  app.get("/research/feed", (req, res) => {
    sse(res);
    const sub = research.subscribe((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
    for (const e of sub.history) res.write(`data: ${JSON.stringify({ ...e, history: true })}\n\n`);
    const ping = setInterval(() => res.write(`: ping\n\n`), 25000);
    req.on("close", () => { sub.close(); clearInterval(ping); });
  });

  app.get("/world/state", (_req, res) => res.json(director.state()));

  const GodSchema = z.discriminatedUnion("op", [
    z.object({ op: z.literal("director"), enabled: z.boolean().optional(), intervalSec: z.number().min(15).max(300).optional() }),
    z.object({ op: z.literal("tick") }),
    z.object({ op: z.literal("event"), text: z.string().max(500).optional(), preset: z.enum(["crisis", "rumor", "windfall", "deadline"]).optional() }),
    z.object({ op: z.literal("goal"), persona: z.string(), title: z.string().min(1).max(140) }),
    z.object({ op: z.literal("conflict"), a: z.string(), b: z.string(), issue: z.string().min(1).max(140) }),
    z.object({ op: z.literal("whisper"), persona: z.string(), text: z.string().min(1).max(300) }),
    z.object({ op: z.literal("resolve"), conflictId: z.string() }),
  ]);
  app.post("/world/god", async (req, res) => {
    const parsed = GodSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map((i) => i.message) });
    const body = parsed.data;
    const twinOf = (ref: string) =>
      db.listTwins().find((t) => t.id === ref || t.name.toLowerCase() === ref.toLowerCase());
    if (body.op === "director") {
      if (body.enabled !== undefined) director.setEnabled(body.enabled);
      if (body.intervalSec !== undefined) director.setIntervalSec(body.intervalSec);
    } else if (body.op === "tick") {
      void director.tick();
    } else if (body.op === "event") {
      const twins = db.listTwins();
      const presets: Record<string, string> = {
        crisis: `Breaking: a major outage just hit a platform everyone depends on`,
        rumor: `Rumor: one of the twins is reportedly leaving the project`,
        windfall: `Surprise: a surprise funding round was just announced`,
        deadline: `Alert: a hard deadline was moved up to tomorrow`,
      };
      const text = body.text?.trim() || presets[body.preset ?? ""] || `${twins[0]?.name ?? "Someone"} faces unexpected news`;
      bus.publish({ personaId: "_god", kind: "post", text }, nameOf);
      if (twins.length) void reactTo(text);
    } else if (body.op === "goal") {
      const t = twinOf(body.persona);
      if (!t) return res.status(404).json({ error: `no twin "${body.persona}"` });
      director.addGoal(t, body.title);
    } else if (body.op === "conflict") {
      const a = twinOf(body.a); const b = twinOf(body.b);
      if (!a || !b) return res.status(404).json({ error: "unknown twin" });
      if (!director.addConflict(a, b, body.issue)) return res.status(409).json({ error: "conflict exists or limit reached" });
    } else if (body.op === "whisper") {
      const t = twinOf(body.persona);
      if (!t) return res.status(404).json({ error: `no twin "${body.persona}"` });
      whispers.set(t.id, body.text);
      bus.publish({ personaId: "_god", kind: "post", text: `${t.name} received a whisper` }, nameOf);
    } else if (body.op === "resolve") {
      if (!director.resolveConflict(body.conflictId)) return res.status(404).json({ error: "unknown conflict" });
    }
    res.json({ ok: true, state: director.state() });
  });

  app.post("/world/chat", async (req, res) => {
    const messages = Array.isArray(req.body?.messages) ? req.body.messages.slice(-20) : [];
    const valid = messages.filter(
      (m: any) => (m?.role === "user" || m?.role === "assistant") && typeof m?.content === "string"
    );
    const lastUser = [...valid].reverse().find((m: any) => m.role === "user");
    if (!lastUser) return res.status(400).json({ error: "messages must include a user message" });

    const twins = db.listTwins();
    const mention = parseMention(lastUser.content, twins.map((t) => t.name));
    let reply: string;
    let actions: WorldAction[];
    if (mention && mention.text) {
      reply = `Asking ${mention.persona}…`;
      actions = [{ type: "ask", persona: mention.persona, text: mention.text }];
    } else {
      let text = "";
      if (chat) {
        try {
          text = await chat([
            { role: "system", content: worldSystemPrompt(twins.map((t) => t.name)) },
            ...valid,
          ]);
        } catch {}
      }
      if (text.trim()) {
        const parsed = extractWorldActions(text);
        reply = parsed.reply;
        actions = parsed.actions;
      } else {
        reply = "";
        actions = [heuristicWorldAction(lastUser.content, twins.map((t) => t.name))];
      }
    }
    if (!reply && actions.length) reply = `Done: ${actions.map((a) => a.type).join(", ")}…`;
    const DEMO_BANNED = new Set(["remove", "director", "goal", "conflict", "simulate"]);
    for (const a of actions) {
      if (demo && !isAdmin(req) && DEMO_BANNED.has(a.type)) {
        bus.publish({ personaId: "_god", kind: "post", text: `The "${a.type}" action isn't available in the hosted demo.` }, nameOf);
        continue;
      }
      void execWorldAction(a).catch(() => {});
    }
    res.json({ reply, actions });
  });

  async function spawnRun(subjectId: string, backend?: string): Promise<AgentRun> {
    const run: AgentRun = {
      id: randomUUID(), subjectId, status: "queued",
      backend: (backend as any) ?? defaultBackend,
      createdAt: new Date().toISOString(),
    };
    const subject = db.getSubject(subjectId)!;
    if (run.backend === "h") {
      if (!hClient) throw new Error("h backend requested but no HAI key configured");
      const session: any = await hClient.createSession(subject, buildTask(subject, toolsJson()));
      run.hSessionId = session.id;
      run.agentViewUrl = session.agent_view_url;
      run.status = "running";
      db.addRun(run);
      void pollHRun(run, hClient, dbx);
      return run;
    }
    await spawnDocker(run, [
      `SUBJECT_JSON=${JSON.stringify(subject)}`,
    ]);
    return run;
  }

  async function spawnDocker(run: AgentRun, extraEnv: string[]): Promise<void> {
    const container = await docker.createContainer({
      Image: agentImage,
      name: `mimk-agent-${run.id}`,
      Labels: { "mimk.run": run.id, "mimk.subject": run.subjectId },
      Env: [
        ...extraEnv,
        `MODEL_BASE_URL=${modelEnv.MODEL_BASE_URL}`,
        `MODEL_NAME=${modelEnv.MODEL_NAME}`,
        `MODEL_API_KEY=${modelEnv.MODEL_API_KEY}`,
        `MODEL_REASONING_EFFORT=${modelEnv.MODEL_REASONING_EFFORT ?? ""}`,
        `MAX_STEPS=${maxSteps}`,
        `RUN_ID=${run.id}`,
        ...(process.env.OPENROUTER_API_KEY ? [`OPENROUTER_API_KEY=${process.env.OPENROUTER_API_KEY}`] : []),
        ...(process.env.OPENROUTER_JEV_MODEL ? [`OPENROUTER_JEV_MODEL=${process.env.OPENROUTER_JEV_MODEL}`] : []),
        ...(process.env.DECISION_PROVIDER ? [`DECISION_PROVIDER=${process.env.DECISION_PROVIDER}`] : []),
      ],
      ExposedPorts: { "6080/tcp": {} },
      HostConfig: {
        AutoRemove: false, ShmSize: 512 * 1024 * 1024,
        PortBindings: { "6080/tcp": [{ HostIp: "127.0.0.1", HostPort: "0" }] },
      },
    });
    await container.start();
    const info = await container.inspect();
    run.containerId = container.id;
    run.vncPort = Number(info.NetworkSettings.Ports["6080/tcp"]?.[0]?.HostPort) || undefined;
    run.status = "running";
    db.addRun(run);
    void attachCollector(run, docker, dbx);
  }

  const prepassCache = new Map<string, Promise<{ person: string; facts: any[]; handles: Record<string, string>; ms: number } | undefined>>();
  const prepass = (person: string, subjectId: string) => {
    const key = person.toLowerCase();
    if (!prepassCache.has(key)) {
      prepassCache.set(key, (async () => {
        try {
          const search = deps.osint?.searchPerson ?? searchPerson;
          const r = await Promise.race([
            search(person, { githubToken: process.env.GITHUB_TOKEN }),
            new Promise<undefined>((res) => setTimeout(() => res(undefined), agentBackend === "none" ? 15000 : 3500)),
          ]);
          if (!r) return undefined;
          const ts = new Date().toISOString();
          for (const f of r.facts) {
            db.addFinding({ runId: `prepass:${subjectId}`, subjectId, sourceUrl: f.sourceUrl, summary: f.summary, ts });
            void onFinding({ runId: `prepass:${subjectId}`, subjectId, sourceUrl: f.sourceUrl, summary: f.summary, ts, instant: true });
          }
          return { person, facts: r.facts, handles: r.handles as Record<string, string>, ms: r.ms };
        } catch {
          return undefined;
        }
      })());
      // keep leads fresh across requests
      setTimeout(() => prepassCache.delete(key), 10 * 60 * 1000).unref?.();
    }
    return prepassCache.get(key)!;
  };

  async function spawnTaskRun(task: SpawnTask): Promise<{ run: AgentRun; instant?: any }> {
    if (typeof task === "string") {
      if (agentBackend === "none")
        throw new Error("live agent desktops aren't available in this hosted demo — ask me to research a named public figure instead (e.g. \"research Linus Torvalds\")");
      if (agentBackend === "h") {
        if (!hClient) throw new Error("agents need the H backend (set MODEL_API_KEY / HAI_API_KEY)");
        const session: any = await hClient.createTaskSession(buildFreeformTask(task));
        const run: AgentRun = {
          id: randomUUID(), subjectId: "_chat", task, status: "running",
          backend: "h", hSessionId: session.id, agentViewUrl: session.agent_view_url,
          createdAt: new Date().toISOString(),
        };
        db.addRun(run);
        void pollHRun(run, hClient, dbx);
        return { run };
      }
      const run: AgentRun = {
        id: randomUUID(), subjectId: "_chat", task, status: "queued",
        backend: "docker", createdAt: new Date().toISOString(),
      };
      await spawnDocker(run, [`TASK=${task}`]);
      research.publish({ runId: run.id, subjectId: "_chat", subject: "task", kind: "start", text: task });
      return { run };
    }
    const person = task.person.trim();
    const extra = task.task.trim();
    let subject = db.listSubjects().find((s) => s.name.toLowerCase() === person.toLowerCase());
    if (!subject) {
      subject = {
        id: randomUUID(), type: "public_figure", name: person,
        approvedSources: OSINT_SOURCES, consent: true,
        consentedAt: new Date().toISOString(), handles: [],
        createdAt: new Date().toISOString(),
      };
      db.addSubject(subject);
    }
    const instant = await prepass(person, subject.id);
    const leadsBlock = instant && (instant.facts.length || Object.keys(instant.handles).length)
      ? `\n\nKnown leads (already collected, verify and extend, don't rediscover): ` +
        instant.facts.map((f: any) => `- ${f.summary} <${f.sourceUrl}>`).join("; ") +
        (Object.keys(instant.handles).length ? `; handles: ${JSON.stringify(instant.handles)}` : "")
      : "";
    const taskText = extra ? `OSINT: ${person} — ${extra}` : `OSINT: ${person}`;
    if (agentBackend === "none") {
      const run: AgentRun = {
        id: randomUUID(), subjectId: subject.id, task: taskText, status: "done",
        backend: "docker", createdAt: new Date().toISOString(),
      };
      db.addRun(run);
      research.publish({ runId: run.id, subjectId: subject.id, subject: subject.name, kind: "done", text: `fast-lane research on ${subject.name} complete` });
      return { run, instant };
    }
    if (agentBackend === "h") {
      if (!hClient) throw new Error("agents need the H backend (set MODEL_API_KEY / HAI_API_KEY)");
      const session: any = await hClient.createSession(
        subject,
        buildTask(subject, toolsJson()) +
          (extra ? `\n\nAdditional instructions from the user: ${extra}` : "") + leadsBlock
      );
      const run: AgentRun = {
        id: randomUUID(), subjectId: subject.id, task: taskText,
        status: "running", backend: "h",
        hSessionId: session.id, agentViewUrl: session.agent_view_url,
        createdAt: new Date().toISOString(),
      };
      db.addRun(run);
      void pollHRun(run, hClient, dbx);
      return { run, instant };
    }
    const run: AgentRun = {
      id: randomUUID(), subjectId: subject.id, task: taskText,
      status: "queued", backend: "docker", createdAt: new Date().toISOString(),
    };
    await spawnDocker(run, [
      `SUBJECT_JSON=${JSON.stringify(subject)}`,
      ...(extra ? [`TASK_EXTRA=${extra}`] : []),
      ...(instant ? [`LEADS_JSON=${JSON.stringify({ name: person, facts: instant.facts.slice(0, 12), handles: instant.handles })}`] : []),
    ]);
    research.publish({ runId: run.id, subjectId: subject.id, subject: subject.name, kind: "start", text: `OSINT run on ${subject.name}${extra ? ` — ${extra}` : ""}` });
    return { run, instant };
  }

  const runningCount = () => db.listRuns().filter((r) => r.status === "running").length;

  app.post("/agents", async (req, res) => {
    const raw = Array.isArray(req.body?.tasks) ? req.body.tasks : undefined;
    const tasks: (SpawnTask | undefined)[] | undefined = raw?.map((t: unknown): SpawnTask | undefined => {
      if (typeof t === "string") return t.trim() ? t : undefined;
      if (t && typeof t === "object" && typeof (t as any).person === "string" && (t as any).person.trim())
        return { person: (t as any).person.trim(), task: typeof (t as any).task === "string" ? (t as any).task : "" };
      return undefined;
    });
    if (!raw?.length || raw.length > 4 || tasks!.some((t) => !t))
      return res.status(400).json({ error: "tasks must be 1..4 non-empty strings or {task, person} objects" });
    const capacity = maxParallel - runningCount();
    if (capacity <= 0) return res.status(429).json({ error: "no agent capacity" });
    const visitorId = demo ? req.header("x-visitor-id") : undefined;
    const runs: AgentRun[] = [];
    const instants: any[] = [];
    for (const task of (tasks as SpawnTask[]).slice(0, capacity)) {
      try {
        const r = await spawnTaskRun(task);
        runs.push(r.run);
        if (r.instant) instants.push(r.instant);
        if (visitorId && r.run.subjectId !== "_chat") db.addVisitorSubject(visitorId, r.run.subjectId);
      } catch (e: any) {
        return res.status(500).json({ error: String(e?.message ?? e), runs });
      }
    }
    res.status(201).json(instants.length ? { runs, instant: instants } : runs);
  });

  app.post("/chat", async (req, res) => {
    const messages = Array.isArray(req.body?.messages) ? req.body.messages.slice(-20) : [];
    const valid = messages.filter(
      (m: any) => (m?.role === "user" || m?.role === "assistant") && typeof m?.content === "string"
    );
    const lastUser = [...valid].reverse().find((m: any) => m.role === "user");
    if (!lastUser) return res.status(400).json({ error: "messages must include a user message" });

    const capacity = Math.max(0, maxParallel - runningCount());
    const visitorId = demo ? req.header("x-visitor-id") : undefined;
    const spawnAll = async (tasks: SpawnTask[]) => {
      const runs: AgentRun[] = [];
      const instants: any[] = [];
      for (const task of tasks.slice(0, capacity)) {
        try {
          const r = await spawnTaskRun(task);
          runs.push(r.run);
          if (r.instant) instants.push(r.instant);
          if (visitorId && r.run.subjectId !== "_chat") db.addVisitorSubject(visitorId, r.run.subjectId);
        } catch (e: any) {
          return { runs, error: String(e?.message ?? e) };
        }
      }
      return { runs, instants };
    };

    let text = "";
    if (chat) {
      try {
        text = await chat([{ role: "system", content: CHAT_SYSTEM_PROMPT }, ...valid]);
      } catch {}
    }
    let { reply, tasks } = text.trim() ? extractSpawn(text) : heuristicSpawn(lastUser.content);
    // deterministic fallback: model talked instead of emitting a spawn block,
    // but the user's intent is explicit enough to spawn heuristically
    if (!tasks.length) {
      const strong = strongIntentSpawn(lastUser.content);
      if (strong.length) {
        tasks = strong;
        if (!reply) reply = `Starting ${strong.length} agent(s)…`;
      } else {
        const h = heuristicSpawn(lastUser.content);
        if (h.tasks.length) {
          tasks = h.tasks;
          if (!reply) reply = `Starting ${h.tasks.length} agent(s)…`;
        }
      }
    }
    if (!tasks.length) return res.json({ reply, runs: [] });
    const { runs, instants, error } = await spawnAll(tasks);
    if (error) reply = `${reply ? reply + "\n" : ""}Couldn't start agents: ${error}`;
    if (!reply && runs.length) reply = `Starting ${runs.length} agent(s)…`;
    res.json({ reply, runs, ...(instants?.length ? { instant: instants } : {}) });
  });

  app.get("/subjects", (_req, res) => res.json(db.listSubjects()));

  app.post("/subjects", (req, res) => {
    const parsed = CreateSubjectSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: parsed.error.issues.map((i) => i.message) });
    const subject = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...parsed.data,
      consentedAt: new Date().toISOString(),
    };
    db.addSubject(subject);
    res.status(201).json(subject);
  });

  app.get("/runs", (_req, res) => res.json(db.listRuns()));

  app.post("/runs", async (req, res) => {
    const { subjectId, count = 1, backend } = req.body ?? {};
    const subject = typeof subjectId === "string" ? db.getSubject(subjectId) : undefined;
    if (!subject) return res.status(400).json({ error: "unknown subjectId" });
    const n = Math.min(Math.max(1, Number(count) || 1), 4);
    const runs: AgentRun[] = [];
    for (let i = 0; i < n; i++) {
      try {
        runs.push(await spawnRun(subject.id, backend));
      } catch (e: any) {
        const run: AgentRun = {
          id: randomUUID(), subjectId: subject.id,
          status: "failed", backend: (backend as any) ?? defaultBackend, createdAt: new Date().toISOString(),
        };
        db.addRun(run);
        return res.status(500).json({ error: String(e?.message ?? e), runs });
      }
    }
    res.status(201).json(runs);
  });

  app.post("/runs/start-all", async (req, res) => {
    const running = db.listRuns().filter((r) => r.status === "running").length;
    const capacity = Math.max(0, maxParallel - running);
    const subjects = db.listSubjects().slice(0, capacity);
    const backend = req.body?.backend;
    const runs: AgentRun[] = [];
    for (const s of subjects) {
      try {
        runs.push(await spawnRun(s.id, backend));
      } catch (e: any) {
        runs.push({
          id: randomUUID(), subjectId: s.id, status: "failed",
          backend: (backend as any) ?? defaultBackend,
          createdAt: new Date().toISOString(),
        });
      }
    }
    res.status(201).json(runs);
  });

  app.get("/runs/:id/events", async (req, res) => {
    const run = db.getRun(req.params.id);
    if (!run) return res.status(404).json({ error: "not found" });
    sse(res);
    // replay persisted findings first — tiles/CLI stay populated after the
    // container is gone (tile dedupes against the live stream's repeats)
    for (const f of db.getFindings(run.subjectId).filter((f) => f.runId === run.id))
      res.write(`data: ${JSON.stringify({
        kind: "finding", runId: run.id, ts: f.ts,
        data: { runId: run.id, sourceUrl: f.sourceUrl, summary: f.summary, ts: f.ts },
      })}\n\n`);
    if (run.backend === "h") {
      const sub = subscribe(run.id, (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`));
      for (const ev of sub.buffered) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      req.on("close", () => sub.close());
      return;
    }
    if (!run.containerId) return res.end();
    try {
      const stream = await docker.getContainer(run.containerId).logs({
        stdout: true, stderr: true, follow: true,
      });
      let buf = "";
      const demux = createLogDemuxer();
      stream.on("data", (chunk: Buffer) => {
        buf += demux(chunk).toString("utf8");
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          const ev = parseEventLine(line, run.id);
          if (ev) res.write(`data: ${JSON.stringify(ev)}\n\n`);
        }
      });
      req.on("close", () => (stream as any).destroy?.());
    } catch {
      res.end();
    }
  });

  app.delete("/runs/:id", async (req, res) => {
    const run = db.getRun(req.params.id);
    if (!run) return res.status(404).json({ error: "not found" });
    if (run.backend === "h" && run.hSessionId && hClient) {
      await hClient.cancelSession(run.hSessionId).catch(() => {});
    }
    if (run.containerId) {
      try {
        const c = docker.getContainer(run.containerId);
        await c.kill().catch(() => {});
        await c.remove({ force: true }).catch(() => {});
      } catch {}
    }
    db.updateRun(run.id, { status: "failed" });
    res.json({ ok: true });
  });

  app.post("/subjects/:id/dossier", (req, res) => {
    const subject = db.getSubject(req.params.id);
    if (!subject) return res.status(404).json({ error: "not found" });
    const provided = Array.isArray(req.body?.findings)
      ? req.body.findings.filter((f: unknown) => FindingSchema.safeParse(f).success)
      : undefined;
    const persisted = db.getFindings(subject.id);
    const findings: Finding[] =
      provided ??
      (persisted.length ? persisted :
        fixtures?.findings.filter((f: any) => f.subjectId === subject.id) ?? []);
    const dossier = buildDossier(subject.id, findings);
    db.saveDossier(dossier);
    res.json(dossier);
  });

  app.post("/runs/:id/twin", async (req, res) => {
    const run = db.getRun(req.params.id);
    if (!run) return res.status(404).json({ error: "not found" });
    const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 80) : "";
    if (!name) return res.status(400).json({ error: "name required" });
    let subject = db.listSubjects().find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (!subject) {
      subject = {
        id: randomUUID(), type: "public_figure", name,
        approvedSources: OSINT_SOURCES, consent: true,
        consentedAt: new Date().toISOString(), handles: [],
        createdAt: new Date().toISOString(),
      };
      db.addSubject(subject);
    }
    // findings UNIQUE key is (runId, sourceUrl, summary) — copy under a
    // provenance runId or INSERT OR IGNORE would silently drop them
    for (const f of db.getFindings(run.subjectId).filter((f) => f.runId === run.id)) {
      db.addFinding({ runId: `twin:${run.id}`, subjectId: subject.id, sourceUrl: f.sourceUrl, summary: f.summary, ts: f.ts });
    }
    const findings: Finding[] = db.getFindings(subject.id);
    const dossier = buildDossier(subject.id, findings);
    db.saveDossier(dossier);
    const persona = chat && req.body?.fixture !== true
      ? await buildPersona(dossier, subject.name, chat)
      : fixturePersona(subject.id, subject.name, dossier);
    db.saveTwin(persona);
    res.json({ subjectId: subject.id, dossier, persona });
  });

  app.post("/subjects/:id/pipeline", async (req, res) => {
    const subject = db.getSubject(req.params.id);
    if (!subject) return res.status(404).json({ error: "not found" });
    const persisted = db.getFindings(subject.id);
    const findings: Finding[] =
      persisted.length ? persisted :
        fixtures?.findings.filter((f: any) => f.subjectId === subject.id) ?? [];
    const dossier = buildDossier(subject.id, findings);
    db.saveDossier(dossier);
    const fixture = fixtures?.personas.find((p) => p.subjectId === subject.id);
    const persona =
      fixture ??
      (chat && req.body?.fixture !== true
        ? await buildPersona(dossier, subject.name, chat)
        : fixturePersona(subject.id, subject.name, dossier));
    db.saveTwin(persona);
    res.json({ dossier, persona });
  });

  app.get("/subjects/:id/dossier", (req, res) => {
    const d = db.getDossier(req.params.id);
    if (!d) return res.status(404).json({ error: "not found" });
    res.json(d);
  });

  app.post("/subjects/:id/twin", async (req, res) => {
    const subject = db.getSubject(req.params.id);
    if (!subject) return res.status(404).json({ error: "not found" });
    const fixture = fixtures?.personas.find((p) => p.subjectId === subject.id);
    let persona: Persona;
    if (req.body?.fixture || !chat) {
      const dossier = db.getDossier(subject.id) ?? buildDossier(subject.id, []);
      persona = fixture ?? fixturePersona(subject.id, subject.name, dossier);
    } else {
      const dossier = db.getDossier(subject.id) ?? buildDossier(subject.id, []);
      persona = fixture ?? (await buildPersona(dossier, subject.name, chat));
    }
    db.saveTwin(persona);
    res.json(persona);
  });

  app.get("/twins", (_req, res) => res.json(db.listTwins()));

  app.delete("/twins", (_req, res) => {
    const removed = db.deleteAllTwins();
    bus.publish({ personaId: "_god", kind: "post", text: "All agents left the world." }, nameOf);
    res.json({ removed });
  });

  app.delete("/twins/:id", (req, res) => {
    const twin = db.getTwin(req.params.id);
    if (!db.deleteTwin(req.params.id)) return res.status(404).json({ error: "not found" });
    bus.publish({ personaId: "_god", kind: "post", text: `${twin!.name} left the world.` }, nameOf);
    res.json({ ok: true });
  });

  const creating = new Set<string>();
  const KINDS = new Set(["person", "company", "business", "task", "idea", "other"]);
  app.post("/twins/from-chat", async (req, res) => {
    const messages = (Array.isArray(req.body?.messages) ? req.body.messages : [])
      .slice(-20)
      .filter((m: any) => (m?.role === "user" || m?.role === "assistant") && typeof m?.content === "string")
      .map((m: any) => ({ role: m.role, content: String(m.content).slice(0, 2000) }));
    const lastUser = [...messages].reverse().find((m: any) => m.role === "user");
    if (!lastUser) return res.status(400).json({ error: "messages must include a user message" });

    let visitorId: string | undefined;
    let visitorSubjects: string[] = [];
    if (demo && !isAdmin(req)) {
      visitorId = req.header("x-visitor-id")!;
      const ip = req.header("x-visitor-ip") ?? "";
      const v = db.touchVisitor(visitorId, ip);
      if (v.twinId)
        return deny(res, "already_created", "You already created an agent — the demo allows one per visitor.");
      if (db.countAgentsByIp(ip) >= demo.ipCap)
        return deny(res, "ip_cap", "Too many agents were already created from this network.");
      if (db.countTwins() >= demo.maxTwins)
        return deny(res, "world_full", "The demo world is full right now — try again later.");
      if (creating.has(visitorId))
        return deny(res, "already_created", "Your agent is already being created.");
      creating.add(visitorId);
      res.on("close", () => creating.delete(visitorId!));
      visitorSubjects = db.listVisitorSubjects(visitorId);
    }

    const transcript = messages.map((m: any) => `${m.role}: ${m.content}`).join("\n").slice(0, 8000);
    // (a) extract what this chat is about
    let name = "";
    let kind = "other";
    let description = "";
    if (chat) {
      try {
        const out = await chat([
          {
            role: "system",
            content:
              "Extract the entity or topic this conversation is about. Reply with raw JSON only: " +
              '{"name":"the entity or topic, <=60 chars","kind":"person|company|business|task|idea|other",' +
              '"description":"what it is and what the user cared about, <=400 chars"}. ' +
              'If the user mostly asked about themselves, use name "Visitor Agent".',
          },
          { role: "user", content: transcript },
        ]);
        const m = out.match(/\{[\s\S]*\}/);
        if (m) {
          const p = JSON.parse(m[0]);
          if (typeof p.name === "string" && p.name.trim()) name = p.name;
          if (typeof p.kind === "string" && KINDS.has(p.kind)) kind = p.kind;
          if (typeof p.description === "string") description = p.description;
        }
      } catch {}
    }
    name = filterSensitive(name).trim().slice(0, 60);
    description = filterSensitive(description).trim().slice(0, 400);
    if (!name) {
      const subjectNames = visitorSubjects.map((id) => db.getSubject(id)?.name).filter(Boolean) as string[];
      const phrases = [...lastUser.content.matchAll(/[A-Z][\w'.-]+(?:\s+[A-Z][\w'.-]+){0,3}/g)]
        .map((m) => ({ text: m[0], at: m.index ?? 0 }))
        // prefer a real entity phrase over a capitalized sentence opener
        .filter((p) => p.text.includes(" ") || p.at > 0);
      name = (subjectNames.at(-1) ?? phrases[0]?.text ?? "Visitor Agent").slice(0, 60);
    }

    // (b) findings the visitor's research already produced
    let subject: Subject | undefined;
    let findings: Finding[] = [];
    const subjectIds = demo
      ? visitorSubjects
      : db.listSubjects().filter((s) => s.name.toLowerCase() === name.toLowerCase()).map((s) => s.id);
    for (const sid of subjectIds) {
      const f = db.getFindings(sid);
      if (f.length) { subject = db.getSubject(sid)!; findings = f; break; }
    }

    // (c) dossier — real research when it exists, synthetic otherwise
    let dossier;
    if (subject && findings.length) {
      dossier = buildDossier(subject.id, findings);
      if (description) dossier.summary = `${dossier.summary} ${description}`.trim().slice(0, 600);
    } else {
      const now = new Date().toISOString();
      subject = {
        id: randomUUID(), type: "public_figure", name,
        approvedSources: ["chat"], consent: true,
        consentedAt: now, handles: [], createdAt: now,
      };
      db.addSubject(subject);
      dossier = {
        subjectId: subject.id,
        facts: [{ claim: description || `A visitor asked about ${name}.`, sourceUrl: "", confidence: 0.5 }],
        summary: (description || `${name}, created from a visitor chat.`).slice(0, 600),
      };
    }
    db.saveDossier(dossier);

    // (d) persona — embodies the thing when it isn't a person
    const persona = await buildPersona(dossier, name, chat, { kind, conversation: transcript });
    db.saveTwin(persona);
    if (demo && visitorId) db.setVisitorTwin(visitorId, persona.id);
    bus.publish({ personaId: "_god", kind: "post", text: `${name} joined the world` }, nameOf);
    research.publish({
      runId: `from-chat:${persona.id}`, subjectId: subject.id, subject: name,
      kind: "world", text: `${name} joined the world`,
    });
    res.status(201).json(persona);
  });

  app.get("/twins/:id/profile", (req, res) => {
    const persona = db.getTwin(req.params.id);
    if (!persona) return res.status(404).json({ error: "not found" });
    const d = persona.subjectId ? db.getDossier(persona.subjectId) : undefined;
    const findings = db.getFindings(persona.subjectId ?? "")
      .slice(-20)
      .map((f) => ({ summary: f.summary, sourceUrl: f.sourceUrl, ts: f.ts }));
    const goals = db.listGoals(false).filter((g: any) => g.personaId === persona.id);
    const conflicts = db.listConflicts(false)
      .filter((c: any) => c.aId === persona.id || c.bId === persona.id)
      .map((c: any) => ({
        ...c,
        otherName: db.getTwin(c.aId === persona.id ? c.bId : c.aId)?.name,
      }));
    const recent = busHistory().filter((e) => e.personaId === persona.id).slice(-10);
    res.json({
      persona,
      dossier: d ? { summary: d.summary, facts: d.facts } : null,
      findings, goals, conflicts, recent,
    });
  });

  app.post("/twins/:id/chat", async (req, res) => {
    const twin = db.getTwin(req.params.id);
    if (!twin) return res.status(404).json({ error: "not found" });
    const message = String(req.body?.message ?? "");
    if (sim?.interview) {
      const via = await sim.interview(twin.name, message).catch(() => undefined);
      if (via) return res.json({ reply: via });
    }
    if (chat) {
      const reply = await chat([
        {
          role: "system",
          content:
            `You are ${twin.name}, a fictional twin persona. Traits: ${twin.traits.join(", ")}. ` +
            `Speech style: ${twin.speechStyle}. Bio: ${twin.bio}. Stay in character, keep replies under 40 words.`,
        },
        { role: "user", content: message },
      ]);
      return res.json({ reply });
    }
    res.json({ reply: cannedReply(twin, message) });
  });

  app.post("/sim/start", async (req, res) => {
    if (!sim) return res.status(503).json({ error: "simulation unavailable" });
    const result = sim.start
      ? await sim.start(
          db.listTwins(),
          Number(req.body?.maxRounds ?? process.env.MIROFISH_MAX_ROUNDS ?? 10),
          typeof req.body?.scenario === "string" ? req.body.scenario : undefined
        ).catch((e) => `error: ${e?.message}`)
      : "unsupported";
    ensurePump();
    res.json({ result });
  });

  app.get("/sim/status", async (_req, res) => {
    res.json({ status: sim?.status ? await sim.status() : "unavailable" });
  });

  app.get("/sim/events", async (req, res) => {
    sse(res);
    const seed = sim?.seedDocument(db.listTwins()) ?? "";
    res.write(`data: ${JSON.stringify({ personaId: "_system", ts: new Date().toISOString(), kind: "post", text: seed.slice(0, 0) })}\n\n`);
    (async () => {
      for await (const e of sim!.events()) {
        res.write(`data: ${JSON.stringify(e)}\n\n`);
        while (injected.length) {
          const ev = injected.shift()!;
          res.write(`data: ${JSON.stringify(ev)}\n\n`);
          for (const t of db.listTwins())
            res.write(`data: ${JSON.stringify({
              personaId: t.id, ts: new Date().toISOString(),
              kind: "reply", text: cannedReply(t, ev.text),
            })}\n\n`);
        }
      }
      res.end();
    })().catch(() => res.end());
    req.on("close", () => res.end());
  });

  app.post("/sim/inject", (req, res) => {
    const text = String(req.body?.text ?? "").slice(0, 300);
    if (!text) return res.status(400).json({ error: "text required" });
    injected.push({
      personaId: "_god", ts: new Date().toISOString(), kind: "post", text,
    });
    res.json({ ok: true });
  });

  if (deps.director?.intervalMs) director.setIntervalSec(deps.director.intervalMs / 1000);
  if (deps.director?.autostart) director.setEnabled(true);
  (app as any)._director = director;
  return app;
}

function cannedReply(t: Persona, msg: string): string {
  const style = t.speechStyle.split(",")[0] ?? "casual";
  return `[${style}] ${t.name}: interesting point about "${msg.slice(0, 40)}" — as someone into ${t.interests[0] ?? "this"}, I'd say it tracks.`;
}


