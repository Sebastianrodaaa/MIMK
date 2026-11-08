import { randomUUID } from "node:crypto";
import { filterSensitive, type Persona } from "@mimk/shared";
import { extractJson } from "./director.js";
import type { Db } from "./db.js";
import type { ChatFn } from "@mimk/twin";

export type SocietyDeps = {
  db: Db;
  chat?: ChatFn;
  post: (personaId: string, kind: "post" | "reply" | "like" | "follow", text: string, targetId?: string) => void;
  director: {
    addGoal(t: Persona, title: string): unknown;
    addConflict(a: Persona, b: Persona, issue: string): unknown;
    resolveConflict(id: string): boolean;
  };
  facts: () => string[];
  whisper: (personaId: string) => string | undefined;
  viewers: () => number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  rng?: () => number;
  maxCallsPerMin?: number;
  tickMs?: number;
  idleGraceMs?: number;
};

const INTENTS = new Set(["agree", "disagree", "ask", "share", "gossip", "ally", "challenge", "joke"]);

export function createSociety(deps: SocietyDeps) {
  const { db, chat, post, director, facts, whisper, viewers } = deps;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const rng = deps.rng ?? Math.random;
  const maxCalls = deps.maxCallsPerMin ?? Number(process.env.SOCIETY_MAX_CALLS_PER_MIN ?? 8);
  const tickMs = deps.tickMs ?? Number(process.env.SOCIETY_TICK_MS ?? 9000);
  const idleGraceMs = deps.idleGraceMs ?? 60000;

  const iso = () => new Date(now()).toISOString();
  const twins = () => db.listTwins();
  const nameOf = (id: string) => db.getTwin(id)?.name ?? id;

  // ── token bucket ──────────────────────────────────────────────
  const callTimes: number[] = [];
  const callsLastMin = () => {
    const cutoff = now() - 60000;
    while (callTimes.length && callTimes[0] < cutoff) callTimes.shift();
    return callTimes.length;
  };
  const budget = () => Math.max(0, maxCalls - callsLastMin());
  const spend = () => callTimes.push(now());

  // ── memory helpers ────────────────────────────────────────────
  const addMemory = (personaId: string, kind: string, text: string, importance = 3, source?: string) => {
    const clean = filterSensitive(String(text)).slice(0, 200).trim();
    if (!clean) return;
    // dedupe same kind+text per persona (e.g. a rumor making the rounds)
    if (db.getMemories(personaId, kind).some((m) => m.text === clean)) return;
    db.addMemory({ id: randomUUID(), personaId, ts: iso(), text: clean, kind, importance, source });
  };
  const relevantMemories = (p: Persona) => {
    const mems = db.getMemories(p.id);
    const cutoff = now() - 5 * 60000;
    return mems
      .map((m) => ({
        m,
        score:
          m.importance * 2 +
          (new Date(m.ts).getTime() > now() - 3600000 ? 3 : 0) +
          (m.kind === "event" && new Date(m.ts).getTime() > cutoff ? 100 : 0),
      }))
      .sort((x, y) => y.score - x.score)
      .slice(0, 4)
      .map((x) => x.m);
  };

  // ── partner selection ─────────────────────────────────────────
  const weighted = <T>(items: [T, number][]): T | undefined => {
    const total = items.reduce((s, [, w]) => s + w, 0);
    if (total <= 0) return items[0]?.[0];
    let r = rng() * total;
    for (const [it, w] of items) { r -= w; if (r <= 0) return it; }
    return items.at(-1)?.[0];
  };
  const pairKey = (a: string, b: string) => [a, b].sort().join("|");
  const recentPairAt = new Map<string, number>();
  const activeConflicts = () => db.listConflicts();
  const goalFor = (pid: string) => db.listGoals().find((g) => g.personaId === pid);
  const lastSpokeAt = new Map<string, number>();

  function pickInitiator(ts: Persona[]): Persona | undefined {
    const conflicts = activeConflicts();
    const inConflict = new Set(conflicts.flatMap((c) => [c.aId, c.bId]));
    const items: [Persona, number][] = ts.map((t) => {
      let w = 1;
      if (inConflict.has(t.id)) w *= 3;
      const g = goalFor(t.id);
      if (g && g.progress < 50) w *= 2;
      const last = lastSpokeAt.get(t.id) ?? 0;
      if (last === 0 || now() - last > tickMs * 4) w *= 2;
      return [t, w];
    });
    return weighted(items);
  }

  function pickPartner(a: Persona, ts: Persona[]): Persona | undefined {
    const conflicts = activeConflicts();
    const items: [Persona, number][] = ts.filter((t) => t.id !== a.id).map((t) => {
      let w = 1;
      if (conflicts.some((c) => pairKey(c.aId, c.bId) === pairKey(a.id, t.id))) w *= 4;
      const rel = db.getRelationship(a.id, t.id);
      if ((rel?.affinity ?? 0) > 20) w *= 2;
      const mine = new Set(a.interests.map((i) => i.toLowerCase()));
      if (t.interests.some((i) => mine.has(i.toLowerCase()))) w *= 2;
      const rel2 = db.listInteractions(50).find((i) => pairKey(i.aId, i.bId) === pairKey(a.id, t.id));
      if (!rel2) w *= 1.5;
      const lastPair = recentPairAt.get(pairKey(a.id, t.id));
      if (lastPair && now() - lastPair < 120000) w *= 0.2;
      return [t, w];
    });
    return weighted(items);
  }

  // ── turn generation ───────────────────────────────────────────
  type Turn = { say: string; intent: string; delta: number; memory: string; mention?: string };
  const clampDelta = (n: unknown) => Math.max(-10, Math.min(10, Math.round(Number(n) || 0)));
  const clean = (s: unknown, max: number) => filterSensitive(String(s ?? "")).slice(0, max).trim();

  async function genTurn(
    speaker: Persona, listener: Persona,
    rel: { affinity: number; status: string; topic: string | null } | undefined,
    convo: string[], latestEvent: string | undefined, rumorText: string | undefined
  ): Promise<Turn | undefined> {
    const goal = goalFor(speaker.id);
    const mems = relevantMemories(speaker);
    const sys =
      `You are ${speaker.name} in a pixel-office world. Stay in character. ` +
      `Reply with raw JSON only: {"say":"<=200 chars, in character, to ${listener.name}",` +
      `"intent":"agree|disagree|ask|share|gossip|ally|challenge|joke",` +
      `"delta":<-10..10 effect on how you feel about ${listener.name}>,` +
      `"memory":"<one-line takeaway you'll remember>",` +
      `"mention":"<optional name of a third person you bring up>"}`;
    const ctx = {
      you: {
        bio: speaker.bio.slice(0, 160), traits: speaker.traits, stances: speaker.stances.slice(0, 3),
        speechStyle: speaker.speechStyle, interests: speaker.interests,
        goal: goal?.title ?? null, secret: whisper(speaker.id) ?? null,
      },
      them: { name: listener.name, bio: listener.bio.slice(0, 120) },
      relationship: rel ? { affinity: rel.affinity, status: rel.status, lastTopic: rel.topic } : null,
      yourMemories: mems.map((m) => `[${m.kind}${m.source ? ` from ${m.source}` : ""}] ${m.text}`),
      latestEvent: latestEvent ?? null,
      gossipYouCouldPassOn: rumorText ?? null,
      conversationSoFar: convo.slice(-6),
    };
    try {
      spend();
      const reply = await chat!([
        { role: "system", content: sys },
        { role: "user", content: JSON.stringify(ctx) },
      ]);
      const j = extractJson(reply);
      if (!j || typeof j.say !== "string" || !j.say.trim()) return undefined;
      return {
        say: clean(j.say, 200) || "…",
        intent: INTENTS.has(j.intent) ? j.intent : "share",
        delta: clampDelta(j.delta),
        memory: clean(j.memory, 140) || clean(j.say, 140),
        mention: typeof j.mention === "string" ? clean(j.mention, 60) : undefined,
      };
    } catch {
      return undefined;
    }
  }

  // deterministic offline turn: lines from real persona data, pair-stable bias
  function fallbackTurn(speaker: Persona, listener: Persona, convo: string[], fact?: string): Turn {
    const pairBias = (() => {
      let h = 0;
      for (const c of pairKey(speaker.id, listener.id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
      return (h % 9) - 4; // -4..4, stable sign per pair
    })();
    const topic = fact?.split(/[.;:]/)[0].slice(0, 60) ?? speaker.interests[0] ?? "the news";
    const intents = ["share", "agree", "ask", "gossip", "joke", pairBias < 0 ? "challenge" : "ally", "disagree"];
    const intent = intents[Math.floor(rng() * intents.length)];
    const style = speaker.speechStyle.split(",")[0] ?? "casual";
    const templates = [
      `As someone ${speaker.traits[0] ? `who's ${speaker.traits[0]}` : "here"}, I keep thinking about ${topic}.`,
      `${listener.name}, what's your take on ${topic}?`,
      speaker.stances[0] ? `I still believe: ${speaker.stances[0].slice(0, 80)}` : `${topic} really matters to me.`,
      `Honestly, ${topic} — that's where I stand, ${listener.name}.`,
      `Being ${speaker.traits[0] ?? "me"}, I'd say ${topic} changes everything.`,
    ];
    const say = clean(templates[Math.floor(rng() * templates.length)], 200) || `[${style}] ${topic}, right?`;
    const delta = Math.max(-10, Math.min(10, pairBias * 2 + Math.floor(rng() * 5) - 2));
    return {
      say,
      intent: INTENTS.has(intent) ? intent : "share",
      delta,
      memory: clean(`${intent} with ${listener.name} about ${topic}`, 140),
    };
  }

  // ── emergence ─────────────────────────────────────────────────
  function emerge(a: Persona, b: Persona, affinity: number, lastBadMemory: string | undefined) {
    const [aId, bId] = [a.id, b.id].sort();
    let rel = db.getRelationship(aId, bId);
    let status = rel?.status ?? "neutral";
    const conflicts = activeConflicts();
    const pairConflict = conflicts.find((c) => pairKey(c.aId, c.bId) === pairKey(a.id, b.id));
    if (affinity <= -40 && !pairConflict && conflicts.length < 3) {
      const issue = (lastBadMemory ?? "a disagreement").slice(0, 140);
      director.addConflict(a, b, issue);
      status = "rival";
      post("_god", "post", `⚔️ ${a.name} and ${b.name} became rivals (emergent)`);
    } else if (affinity >= 50 && status !== "ally") {
      status = "ally";
      post("_god", "post", `🤝 ${a.name} and ${b.name} formed an alliance (emergent)`);
    }
    if (pairConflict && affinity > 10) {
      director.resolveConflict(pairConflict.id);
      post("_god", "post", `🕊️ ${a.name} and ${b.name} patched things up (emergent)`);
      if (status === "rival") status = "neutral";
    }
    db.saveRelationship(aId, bId, {
      affinity, status,
      lastAt: iso(),
      topic: (lastBadMemory ?? rel?.topic ?? "").slice(0, 140) || null,
    });
  }

  async function reflect(t: Persona) {
    if (!chat || budget() < 1) return;
    try {
      spend();
      const mems = relevantMemories(t).map((m) => m.text);
      const reply = await chat([
        {
          role: "system",
          content:
            `You are ${t.name}. Reflect briefly on your recent experiences. ` +
            `Reply with raw JSON only: {"reflection":"<one insight>","goal":"<optional new personal goal, <=100 chars>"}`,
        },
        { role: "user", content: JSON.stringify({ memories: mems, traits: t.traits, bio: t.bio.slice(0, 120) }) },
      ]);
      const j = extractJson(reply);
      if (!j) return;
      if (typeof j.reflection === "string" && j.reflection.trim())
        addMemory(t.id, "reflection", j.reflection, 4);
      if (typeof j.goal === "string" && j.goal.trim() && !goalFor(t.id)) {
        director.addGoal(t, clean(j.goal, 100));
        post("_god", "post", `🎯 ${t.name} decided to ${clean(j.goal, 100)} (emergent)`);
      }
    } catch {}
  }

  // ── the tick ──────────────────────────────────────────────────
  let lastTickAt: string | null = null;
  let ticking = false;

  async function tick(): Promise<Record<string, unknown>> {
    if (ticking) return { skipped: "ticking" };
    const ts = twins();
    if (ts.length < 2) return { skipped: "twins<2" };
    if (chat && budget() < 2) return { skipped: "budget" };
    ticking = true;
    try {
      const a = pickInitiator(ts)!;
      const b = pickPartner(a, ts)!;
      const rel = db.getRelationship(a.id, b.id);
      const latestEvent = ts
        .flatMap((t) => db.getMemories(t.id, "event"))
        .sort((x, y) => y.ts.localeCompare(x.ts))[0]?.text;
      const fact = facts()[0];

      const turns = !chat ? 4 : budget() >= 4 ? (rng() < 0.5 ? 3 : 4) : 2;
      const convo: string[] = [];
      let totalDelta = 0;
      let lastIntent = "share";
      let lastBadMemory: string | undefined;
      let lastTopic = "";
      for (let i = 0; i < turns; i++) {
        const speaker = i % 2 === 0 ? a : b;
        const listener = i % 2 === 0 ? b : a;
        const rumor = db.getMemories(speaker.id, "rumor")[0]?.text;
        const turn = chat
          ? (await genTurn(speaker, listener, rel, convo, latestEvent, rumor)) ?? fallbackTurn(speaker, listener, convo, fact)
          : fallbackTurn(speaker, listener, convo, fact);
        post(speaker.id, "reply", turn.say, listener.id);
        lastSpokeAt.set(speaker.id, now());
        convo.push(`${speaker.name}: ${turn.say}`);
        totalDelta += turn.delta;
        lastIntent = turn.intent;
        lastTopic = turn.memory;
        if (turn.intent === "disagree" || turn.intent === "challenge") lastBadMemory = turn.memory;
        // gossip diffusion + third-party mentions become listener rumors
        if (rumor && (turn.intent === "gossip" || turn.intent === "share"))
          addMemory(listener.id, "rumor", rumor, 4, speaker.name);
        if (turn.mention) {
          const other = ts.find((t) => t.name.toLowerCase() === turn.mention!.toLowerCase());
          if (other && other.id !== listener.id)
            addMemory(listener.id, "rumor", turn.memory || `heard about ${other.name}`, 4, speaker.name);
        }
        await sleep(400);
      }
      totalDelta = Math.max(-20, Math.min(20, totalDelta));
      const newAffinity = (rel?.affinity ?? 0) + totalDelta;
      emerge(a, b, newAffinity, lastBadMemory ?? lastTopic);
      addMemory(a.id, "chat", `Talked with ${b.name}: ${convo.at(-2)?.split(": ").slice(1).join(": ") ?? lastTopic}`, 3, b.name);
      addMemory(b.id, "chat", `Talked with ${a.name}: ${convo.at(-1)?.split(": ").slice(1).join(": ") ?? lastTopic}`, 3, a.name);
      db.addInteraction({
        id: randomUUID(), ts: iso(), aId: a.id, bId: b.id,
        summary: clean(convo.at(-1) ?? "", 140), intent: lastIntent, delta: totalDelta,
      });
      recentPairAt.set(pairKey(a.id, b.id), now());
      lastTickAt = iso();
      // reflection every 6th interaction per persona
      for (const t of [a, b])
        if (db.countInteractionsFor(t.id) % 6 === 0) await reflect(t);
      return { a: a.name, b: b.name, delta: totalDelta, affinity: db.getRelationship(a.id, b.id)?.affinity, turns };
    } finally {
      ticking = false;
    }
  }

  // ── scheduler: only burns calls while someone is watching ─────
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastViewerAt = 0;
  const watching = () => viewers() > 0 || now() - lastViewerAt < idleGraceMs;
  const fire = async () => {
    timer = undefined;
    if (!running) return;
    if (!watching()) return; // sleep until next wake()
    await tick().catch(() => {});
    schedule();
  };
  const schedule = (ms = tickMs) => {
    if (!running) return;
    timer = setTimeout(fire, ms);
    timer.unref?.();
  };

  return {
    start() { if (!running) { running = true; schedule(); } },
    stop() { running = false; if (timer) clearTimeout(timer); timer = undefined; },
    wake() {
      lastViewerAt = now();
      if (!running || ticking) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(fire, Math.min(1200, tickMs));
      timer.unref?.();
    },
    tickOnce: () => tick(),
    recordEvent(text: string) {
      const cleanText = clean(text, 200);
      if (!cleanText) return;
      for (const t of twins()) addMemory(t.id, "event", cleanText, 5);
      lastViewerAt = now();
      this.wake();
    },
    recordRumor(personaId: string, text: string, source?: string) {
      addMemory(personaId, "rumor", text, 4, source);
    },
    profileFor(personaId: string) {
      const t = db.getTwin(personaId);
      const relationships = db.listRelationships()
        .filter((r) => r.aId === personaId || r.bId === personaId)
        .map((r) => {
          const otherId = r.aId === personaId ? r.bId : r.aId;
          return { otherId, otherName: nameOf(otherId), affinity: r.affinity, status: r.status, topic: r.topic };
        })
        .sort((x, y) => Math.abs(y.affinity) - Math.abs(x.affinity));
      const memories = db.getMemories(personaId).slice(0, 6)
        .map((m) => ({ ts: m.ts, kind: m.kind, text: m.text, source: m.source }));
      const interactions = db.listInteractions(50)
        .filter((i) => i.aId === personaId || i.bId === personaId)
        .slice(0, 5)
        .map((i) => ({ ts: i.ts, otherId: i.aId === personaId ? i.bId : i.aId, otherName: nameOf(i.aId === personaId ? i.bId : i.aId), summary: i.summary, intent: i.intent, delta: i.delta }));
      return { name: t?.name, relationships, memories, interactions };
    },
    pulse() {
      const rels = db.listRelationships();
      const conflicts = activeConflicts();
      // factions: connected components over pairs with affinity >= 30
      const adj = new Map<string, Set<string>>();
      for (const r of rels.filter((r) => r.affinity >= 30)) {
        (adj.get(r.aId) ?? adj.set(r.aId, new Set()).get(r.aId)!).add(r.bId);
        (adj.get(r.bId) ?? adj.set(r.bId, new Set()).get(r.bId)!).add(r.aId);
      }
      const seen = new Set<string>();
      const factions: string[][] = [];
      for (const start of adj.keys()) {
        if (seen.has(start)) continue;
        const comp: string[] = [];
        const stack = [start];
        while (stack.length) {
          const n = stack.pop()!;
          if (seen.has(n)) continue;
          seen.add(n);
          comp.push(nameOf(n));
          for (const m of adj.get(n) ?? []) stack.push(m);
        }
        if (comp.length >= 2) factions.push(comp.sort());
      }
      // rumors grouped by text
      const rumorMap = new Map<string, { origin?: string; aware: Set<string> }>();
      for (const t of twins()) {
        for (const m of db.getMemories(t.id, "rumor")) {
          const e = rumorMap.get(m.text) ?? { aware: new Set<string>() };
          e.aware.add(t.name);
          if (m.source) e.origin ??= m.source;
          rumorMap.set(m.text, e);
        }
      }
      const rumors = [...rumorMap.entries()].slice(-5).map(([text, e]) => ({
        text, origin: e.origin, aware: [...e.aware],
      })).reverse();
      const topicCount = new Map<string, number>();
      for (const r of rels) if (r.topic) topicCount.set(r.topic, (topicCount.get(r.topic) ?? 0) + 1);
      for (const t of twins())
        for (const m of db.getMemories(t.id, "chat").slice(0, 10))
          for (const w of m.text.split(/\W+/))
            if (w.length > 7) topicCount.set(w, (topicCount.get(w) ?? 0) + 1);
      const topTopics = [...topicCount.entries()]
        .sort((x, y) => y[1] - x[1]).slice(0, 5)
        .map(([topic, count]) => ({ topic, count }));
      const mood = rels.length ? rels.reduce((s, r) => s + r.affinity, 0) / rels.length : 0;
      return {
        interactions10m: db.interactionsSince(new Date(now() - 600000).toISOString()),
        interactionsTotal: db.countInteractions(),
        alliances: rels.filter((r) => r.status === "ally").map((r) => ({ a: nameOf(r.aId), b: nameOf(r.bId) })),
        rivalries: conflicts.map((c) => ({ a: nameOf(c.aId), b: nameOf(c.bId), issue: c.issue })),
        factions, topTopics, rumors, mood: Math.round(mood * 10) / 10,
        watching: watching(),
        lastTickAt,
        llmCallsLastMin: callsLastMin(),
      };
    },
  };
}
export type Society = ReturnType<typeof createSociety>;
