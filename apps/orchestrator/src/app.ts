import express from "express";
import { randomUUID } from "node:crypto";
import {
  CreateSubjectSchema, FindingSchema,
  type AgentRun, type Finding, type Persona, type SimEvent,
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
  agentBackend?: "docker" | "h";
  osint?: { searchPerson: typeof searchPerson };
  status?: () => Record<string, unknown>;
  worldDelayMs?: number;
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
  const sim: SimBackend = deps.simBackend ?? new ReplayBackend(fixtures?.events ?? []);
  const hClient = deps.hClient;
  const defaultBackend = deps.runBackend ?? (hClient ? "h" : "docker");
  const agentBackend = deps.agentBackend ?? "docker";
  const injected: SimEvent[] = [];
  const worldDelayMs = deps.worldDelayMs ?? 400;

  const bus = createBus();
  const nameOf = (id: string) => db.getTwin(id)?.name ?? (id === "_god" ? "Event" : id);
  let pump: Promise<void> | undefined;
  const ensurePump = () => {
    pump ??= (async () => {
      for await (const e of sim.events()) {
        if (e.personaId === "_system" || !e.text?.trim()) continue;
        bus.publish(e, nameOf);
      }
    })().catch(() => {}).finally(() => { pump = undefined; });
  };

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const twinPrompt = (t: Persona, words: number) =>
    `You are ${t.name}, a fictional twin persona. Traits: ${t.traits.join(", ")}. ` +
    `Speech style: ${t.speechStyle}. Bio: ${t.bio}. Stay in character, keep replies under ${words} words.`;
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
    const via = sim.interview ? await sim.interview(twin.name, text).catch(() => undefined) : undefined;
    const reply = via ?? (await inCharacter(twin, text, cannedReply(twin, text)));
    bus.publish({ personaId: twin.id, kind: "reply", text: reply }, nameOf);
  }

  async function execWorldAction(a: WorldAction) {
    const twins = db.listTwins();
    if (a.type === "simulate") {
      if (!twins.length) { noTwins(); return; }
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
  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    next();
  });
  app.options("*path", (_req, res) => res.end());
  app.get("/status", (_req, res) =>
    res.json({
      runBackend: defaultBackend,
      sim: deps.simBackend ? "mirofish" : "replay",
      model: modelEnv.MODEL_NAME || "unset",
      modelKey: modelEnv.MODEL_API_KEY ? "set" : "unset",
      maxParallel,
      ...(deps.status?.() ?? {}),
    }));
  app.use(express.json());

  app.get("/world/feed", (req, res) => {
    sse(res);
    const sub = bus.subscribe((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
    for (const e of sub.history) res.write(`data: ${JSON.stringify({ ...e, history: true })}\n\n`);
    const ping = setInterval(() => res.write(`: ping\n\n`), 25000);
    req.on("close", () => { sub.close(); clearInterval(ping); });
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
    for (const a of actions) void execWorldAction(a).catch(() => {});
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
      void pollHRun(run, hClient, db);
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
    void attachCollector(run, docker, db);
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
            new Promise<undefined>((res) => setTimeout(() => res(undefined), 3500)),
          ]);
          if (!r) return undefined;
          const ts = new Date().toISOString();
          for (const f of r.facts)
            db.addFinding({ runId: `prepass:${subjectId}`, subjectId, sourceUrl: f.sourceUrl, summary: f.summary, ts });
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
      if (agentBackend === "h") {
        if (!hClient) throw new Error("agents need the H backend (set MODEL_API_KEY / HAI_API_KEY)");
        const session: any = await hClient.createTaskSession(buildFreeformTask(task));
        const run: AgentRun = {
          id: randomUUID(), subjectId: "_chat", task, status: "running",
          backend: "h", hSessionId: session.id, agentViewUrl: session.agent_view_url,
          createdAt: new Date().toISOString(),
        };
        db.addRun(run);
        void pollHRun(run, hClient, db);
        return { run };
      }
      const run: AgentRun = {
        id: randomUUID(), subjectId: "_chat", task, status: "queued",
        backend: "docker", createdAt: new Date().toISOString(),
      };
      await spawnDocker(run, [`TASK=${task}`]);
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
      void pollHRun(run, hClient, db);
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
    const runs: AgentRun[] = [];
    const instants: any[] = [];
    for (const task of (tasks as SpawnTask[]).slice(0, capacity)) {
      try {
        const r = await spawnTaskRun(task);
        runs.push(r.run);
        if (r.instant) instants.push(r.instant);
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
    const spawnAll = async (tasks: SpawnTask[]) => {
      const runs: AgentRun[] = [];
      const instants: any[] = [];
      for (const task of tasks.slice(0, capacity)) {
        try {
          const r = await spawnTaskRun(task);
          runs.push(r.run);
          if (r.instant) instants.push(r.instant);
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

  app.post("/twins/:id/chat", async (req, res) => {
    const twin = db.getTwin(req.params.id);
    if (!twin) return res.status(404).json({ error: "not found" });
    const message = String(req.body?.message ?? "");
    if (sim.interview) {
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
    res.json({ status: sim.status ? await sim.status() : "replay" });
  });

  app.get("/sim/events", async (req, res) => {
    sse(res);
    const seed = sim.seedDocument(db.listTwins());
    res.write(`data: ${JSON.stringify({ personaId: "_system", ts: new Date().toISOString(), kind: "post", text: seed.slice(0, 0) })}\n\n`);
    (async () => {
      for await (const e of sim.events()) {
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

  return app;
}

function cannedReply(t: Persona, msg: string): string {
  const style = t.speechStyle.split(",")[0] ?? "casual";
  return `[${style}] ${t.name}: interesting point about "${msg.slice(0, 40)}" — as someone into ${t.interests[0] ?? "this"}, I'd say it tracks.`;
}


