import { randomUUID } from "node:crypto";
import type { Persona, SimEvent } from "@mimk/shared";

export type Goal = { id: string; personaId: string; title: string; progress: number; status: string; createdAt: string };
export type Conflict = { id: string; aId: string; bId: string; issue: string; intensity: number; status: string; createdAt: string };

export type DirectorDeps = {
  db: {
    listTwins(): Persona[];
    getTwin(id: string): Persona | undefined;
    addGoal(g: Goal): void;
    listGoals(activeOnly?: boolean): Goal[];
    updateGoal(id: string, patch: { progress?: number; status?: string }): void;
    addConflict(c: Conflict): void;
    listConflicts(activeOnly?: boolean): Conflict[];
    updateConflict(id: string, patch: { status?: string; intensity?: number }): void;
    getWorldState(key: string): string | undefined;
    setWorldState(key: string, value: string): void;
  };
  chat?: (messages: { role: string; content: string }[]) => Promise<string>;
  post: (personaId: string, kind: SimEvent["kind"], text: string) => void;
  facts?: () => string[];                    // recent world fact summaries
  feed?: () => string[];                     // recent feed lines "name: text"
  whisper?: (personaId: string) => string | undefined;
  sleep?: (ms: number) => Promise<void>;
  worldDelayMs?: number;
  now?: () => number;
};

const DEF_INTERVAL_MS = 45000;
const MIN_INTERVAL_MS = 15000;
const MAX_INTERVAL_MS = 300000;

export function extractJson(text: string): any | undefined {
  const clean = text.replace(/```(?:json)?\s*|```/g, " ");
  let depth = 0, inStr = false, esc = false, start = -1;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") { if (depth++ === 0) start = i; continue; }
    if (c === "}") {
      if (depth > 0 && --depth === 0 && start >= 0) {
        try { return JSON.parse(clean.slice(start, i + 1)); } catch { return undefined; }
      }
    }
  }
  return undefined;
}

// Deterministic fallback built only from real data — used when the model is
// missing, fails, or returns garbage.
export function templateTick(twins: Persona[], facts: string[]): { event?: string; lines: { persona: string; text: string }[]; newConflict?: { a: string; b: string; issue: string; intensity: number }; goals: { persona: string; title: string }[]; progress: { persona: string; delta: number }[] } {
  const fact = facts[0] ?? "the latest research findings";
  const [a, b] = twins;
  const topic = fact.split(/[.;:]/)[0].slice(0, 60);
  return {
    event: `New research is circulating in the office: ${topic}`,
    lines: twins.slice(0, 3).map((t) => ({
      persona: t.name,
      text: `${t.traits[0] ? `Being ${t.traits[0]}, I` : "I"} can't ignore "${topic}".`,
    })),
    newConflict: twins.length >= 2
      ? { a: a.name, b: b.name, issue: `they disagree about the implications of ${topic}`, intensity: 3 }
      : undefined,
    goals: twins.slice(0, 3).map((t) => ({ persona: t.name, title: `Dig into ${topic}` })),
    progress: twins.map((t) => ({ persona: t.name, delta: 10 })),
  };
}

export function createDirector(deps: DirectorDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const worldDelayMs = deps.worldDelayMs ?? 400;
  const post = deps.post;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let ticking = false;
  let backoff = 1;
  let lastTickAt: string | null = null;
  let nextAt: number | null = null;
  let queued = false;

  const enabled = () => (db.getWorldState("director.enabled") ?? "0") === "1";
  const intervalMs = () => {
    const v = Number(db.getWorldState("director.intervalMs") ?? DEF_INTERVAL_MS);
    return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Number.isFinite(v) ? v : DEF_INTERVAL_MS));
  };
  const goalFor = (pid: string) => db.listGoals().find((g) => g.personaId === pid);
  const twinOf = (ref: string) =>
    db.listTwins().find((t) => t.id === ref || t.name.toLowerCase() === ref.toLowerCase());

  const stripLead = (s: string) => s.trim().replace(/^[^\p{L}\p{N}]+/u, "").trim();

  function ensureGoal(t: Persona): Goal {
    const existing = goalFor(t.id);
    if (existing) return existing;
    const topic = (deps.facts?.()[0] ?? t.bio ?? t.name).split(/[.;:]/)[0].slice(0, 60);
    const g: Goal = { id: randomUUID(), personaId: t.id, title: `Follow up on ${topic}`, progress: 0, status: "active", createdAt: new Date(now()).toISOString() };
    db.addGoal(g);
    post("_god", "post", `🎯 Goal — ${t.name}: ${g.title}`);
    return g;
  }

  function addConflict(a: Persona, b: Persona, issue: string, intensity = 3) {
    const pair = (x: string, y: string) => [x, y].sort().join("|");
    const active = db.listConflicts();
    if (active.some((c) => pair(c.aId, c.bId) === pair(a.id, b.id))) return undefined;
    if (active.length >= 3) return undefined;
    const c: Conflict = { id: randomUUID(), aId: a.id, bId: b.id, issue: issue.slice(0, 140), intensity: Math.min(5, Math.max(1, Math.round(intensity))), status: "active", createdAt: new Date(now()).toISOString() };
    db.addConflict(c);
    post("_god", "post", `⚔️ Conflict — ${a.name} vs ${b.name}: ${c.issue}`);
    return c;
  }

  function addGoal(t: Persona, title: string) {
    const g: Goal = { id: randomUUID(), personaId: t.id, title: title.slice(0, 140), progress: 0, status: "active", createdAt: new Date(now()).toISOString() };
    db.addGoal(g);
    post("_god", "post", `🎯 Goal — ${t.name}: ${g.title}`);
    return g;
  }

  async function tick(): Promise<{ ok: boolean; usedModel: boolean }> {
    if (ticking) return { ok: false, usedModel: false };
    ticking = true;
    try {
      const twins = db.listTwins();
      if (twins.length < 2) return { ok: false, usedModel: false };
      const facts = deps.facts?.() ?? [];
      const feedLines = (deps.feed?.() ?? []).slice(-8);
      const activeGoals = db.listGoals();
      const activeConflicts = db.listConflicts();
      const prompt = {
        twins: twins.map((t) => ({
          name: t.name, traits: t.traits, bio: t.bio.slice(0, 120),
          goal: activeGoals.find((g) => g.personaId === t.id)?.title ?? null,
          whisper: deps.whisper?.(t.id) ?? null,
        })),
        conflicts: activeConflicts.map((c) => ({ id: c.id, a: nameOfId(c.aId), b: nameOfId(c.bId), issue: c.issue, intensity: c.intensity })),
        feed: feedLines,
        facts: facts.slice(0, 5),
      };

      let usedModel = false;
      let out: any;
      if (deps.chat) {
        try {
          const reply = await deps.chat([
            { role: "system", content: `You direct a tiny pixel-office world of persona twins. Reply with ONE JSON object only: {"event":"<optional world event>","lines":[{"persona":"<twin name>","text":"<short line they say>"}],"newConflict":{"a":"<name>","b":"<name>","issue":"<why>","intensity":<1-5>},"goals":[{"persona":"<name>","title":"<goal>"}],"progress":[{"persona":"<name>","delta":<-20..30>}],"resolve":["<conflict id>"]}. Keep everything realistic to the twins' bios and the recent research facts.` },
            { role: "user", content: JSON.stringify(prompt) },
          ]);
          out = extractJson(reply);
          usedModel = !!out;
        } catch {}
      }
      if (!out) out = templateTick(twins, facts);

      if (typeof out.event === "string" && out.event.trim())
        post("_god", "post", `⚡ ${stripLead(out.event).slice(0, 200)}`);

      for (const line of (Array.isArray(out.lines) ? out.lines : []).slice(0, 6)) {
        const t = twinOf(String(line?.persona ?? ""));
        if (!t || typeof line?.text !== "string" || !line.text.trim()) continue;
        post(t.id, "reply", line.text.trim().slice(0, 220));
        await sleep(worldDelayMs);
      }

      if (out.newConflict?.a && out.newConflict?.b) {
        const a = twinOf(String(out.newConflict.a));
        const b = twinOf(String(out.newConflict.b));
        if (a && b && a.id !== b.id) addConflict(a, b, stripLead(String(out.newConflict.issue ?? "a disagreement")), Number(out.newConflict.intensity ?? 3));
      }

      for (const g of (Array.isArray(out.goals) ? out.goals : []).slice(0, 6)) {
        const t = twinOf(String(g?.persona ?? ""));
        if (t && typeof g?.title === "string" && g.title.trim() && !goalFor(t.id)) addGoal(t, stripLead(g.title));
      }

      for (const p of (Array.isArray(out.progress) ? out.progress : [])) {
        const t = twinOf(String(p?.persona ?? ""));
        const g = t && ensureGoal(t);
        const delta = Number(p?.delta);
        if (!g || !Number.isFinite(delta)) continue;
        const next = Math.min(100, Math.max(0, g.progress + Math.min(30, Math.max(-20, delta))));
        db.updateGoal(g.id, { progress: next });
        if (next >= 100) {
          db.updateGoal(g.id, { status: "done" });
          post("_god", "post", `✅ ${t!.name} completed their goal: ${g.title}`);
        }
      }

      for (const cid of Array.isArray(out.resolve) ? out.resolve : []) {
        const c = activeConflicts.find((x) => x.id === cid);
        if (c) {
          db.updateConflict(c.id, { status: "resolved" });
          post("_god", "post", `🤝 Resolved — ${nameOfId(c.aId)} vs ${nameOfId(c.bId)}`);
        }
      }

      // invariants
      for (const t of twins) ensureGoal(t);

      lastTickAt = new Date(now()).toISOString();
      return { ok: true, usedModel };
    } finally {
      ticking = false;
    }
  }

  const nameOfId = (id: string) => db.getTwin(id)?.name ?? id;

  function scheduleNext() {
    if (timer) clearTimeout(timer);
    const wait = intervalMs() * backoff;
    nextAt = now() + wait;
    timer = setTimeout(async () => {
      if (!enabled()) return;
      const r = await tick().catch(() => ({ ok: false, usedModel: false }));
      backoff = r.usedModel ? 1 : Math.min(4, backoff * 2);
      scheduleNext();
    }, wait);
    timer.unref?.();
  }

  return {
    tick,
    state() {
      const twins = db.listTwins();
      return {
        director: {
          enabled: enabled(),
          intervalSec: Math.round(intervalMs() / 1000),
          nextAt: nextAt ? new Date(nextAt).toISOString() : null,
          lastTickAt,
        },
        goals: db.listGoals(),
        conflicts: db.listConflicts(),
        twins: twins.map((t) => ({ id: t.id, name: t.name, goal: goalFor(t.id)?.title })),
      };
    },
    nudgeSoon() {
      // new finding: react within ~3s instead of waiting for the full interval
      if (!enabled()) return;
      if (queued || (nextAt && nextAt - now() <= 3000)) return;
      queued = true;
      if (timer) clearTimeout(timer);
      nextAt = now() + 3000;
      timer = setTimeout(async () => {
        queued = false;
        if (!enabled()) return;
        const r = await tick().catch(() => ({ ok: false, usedModel: false }));
        backoff = r.usedModel ? 1 : Math.min(4, backoff * 2);
        scheduleNext();
      }, 3000);
      timer.unref?.();
    },
    setEnabled(v: boolean) {
      db.setWorldState("director.enabled", v ? "1" : "0");
      if (v) { backoff = 1; scheduleNext(); }
      else if (timer) { clearTimeout(timer); timer = undefined; nextAt = null; }
    },
    setIntervalSec(sec: number) {
      db.setWorldState("director.intervalMs", String(Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(sec * 1000)))));
      if (enabled()) scheduleNext();
    },
    addGoal, addConflict,
    resolveConflict(id: string) {
      const c = db.listConflicts().find((x) => x.id === id);
      if (!c) return false;
      db.updateConflict(id, { status: "resolved" });
      post("_god", "post", `🤝 Resolved — ${nameOfId(c.aId)} vs ${nameOfId(c.bId)}`);
      return true;
    },
    stop() { if (timer) clearTimeout(timer); timer = undefined; },
  };
}
export type Director = ReturnType<typeof createDirector>;
