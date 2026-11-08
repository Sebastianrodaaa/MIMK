import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createSociety } from "../src/society.js";
import { createDb } from "../src/db.js";
import { createDirector } from "../src/director.js";
import { createBus } from "../src/bus.js";
import { createApp } from "../src/app.js";
import { fixturePersona, buildDossier } from "@mimk/twin";
import type { Persona } from "@mimk/shared";

const mkTwin = (id: string, name: string, interests = ["tech"]): Persona => {
  const p = fixturePersona(id, name, buildDossier(id, []));
  return { ...p, interests };
};

// mulberry32 — deterministic rng
const seeded = (s: number) => () => {
  s |= 0; s = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const mk = (over: any = {}) => {
  const db = createDb(":memory:");
  const posts: any[] = [];
  const director = createDirector({
    db: db as any,
    post: (personaId, kind, text) => posts.push({ personaId, kind, text }),
  });
  const nowRef = { t: 0 };
  const society = createSociety({
    db,
    post: (personaId: string, kind: string, text: string, targetId?: string) =>
      posts.push({ personaId, kind, text, targetId }),
    director,
    facts: () => ["New study on remote work published."],
    whisper: () => undefined,
    viewers: () => over.viewersNow ?? 1,
    now: () => nowRef.t,
    sleep: () => Promise.resolve(),
    rng: over.rng ?? seeded(42),
    maxCallsPerMin: over.maxCallsPerMin ?? 100,
    tickMs: over.tickMs ?? 9000,
    idleGraceMs: over.idleGraceMs ?? 60000,
    ...(over.chat !== undefined ? { chat: over.chat } : {}),
  });
  return { db, posts, director, society, nowRef };
};

const seedTwins = (db: ReturnType<typeof createDb>, n: number) => {
  const names = ["Ada", "Marco", "Priya", "Kenji"];
  const ts: Persona[] = [];
  for (let i = 0; i < n; i++) {
    const t = mkTwin(`s${i}`, names[i], i % 2 ? ["art", "music"] : ["tech", "art"]);
    db.saveTwin(t);
    ts.push(t);
  }
  return ts;
};

describe("society scheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not tick when viewers()=0 and grace expired", async () => {
    const { db, society, nowRef } = mk({ viewersNow: 0, idleGraceMs: 100, tickMs: 1000 });
    seedTwins(db, 2);
    nowRef.t = 100000;
    society.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(db.countInteractions()).toBe(0);
    society.stop();
  });

  it("wake() runs a tick within ~1.5s", async () => {
    const { db, society, nowRef } = mk({ viewersNow: 0, tickMs: 9000 });
    seedTwins(db, 2);
    society.start();
    society.wake();
    await vi.advanceTimersByTimeAsync(1400);
    expect(db.countInteractions()).toBe(1);
    society.stop();
  });
});

describe("token bucket", () => {
  it("never exceeds maxCallsPerMin", async () => {
    let calls = 0;
    const chat = async () => { calls++; return '{"say":"hi","intent":"agree","delta":1,"memory":"m"}'; };
    const { db, society } = mk({ chat, maxCallsPerMin: 3 });
    seedTwins(db, 2);
    for (let i = 0; i < 6; i++) await society.tickOnce();
    expect(calls).toBeLessThanOrEqual(3);
  });
});

describe("emergence", () => {
  it("negative affinity creates a rival conflict; recovery resolves it; high affinity creates alliance", async () => {
    const posts: any[] = [];
    const db = createDb(":memory:");
    const director = createDirector({ db: db as any, post: (p, k, t) => posts.push({ p, k, t }) });
    let delta = -10;
    const chat = async () => JSON.stringify({ say: "ugh", intent: "challenge", delta, memory: "fighting over direction" });
    const s = createSociety({
      db, chat,
      post: (p: string, k: any, t: string, targetId?: string) => posts.push({ p, k, t, targetId }),
      director, facts: () => [], whisper: () => undefined, viewers: () => 1,
      sleep: () => Promise.resolve(), rng: seeded(1), maxCallsPerMin: 100,
    });
    const [a, b] = seedTwins(db, 2);
    await s.tickOnce();
    expect(db.getRelationship(a.id, b.id)!.affinity).toBe(-20);
    await s.tickOnce();
    const rel = db.getRelationship(a.id, b.id)!;
    expect(rel.affinity).toBe(-40);
    expect(rel.status).toBe("rival");
    expect(db.listConflicts()).toHaveLength(1);
    expect(posts.some((p) => p.t.includes("became rivals") && p.t.includes("emergent"))).toBe(true);

    delta = 10;
    await s.tickOnce(); // -20
    await s.tickOnce(); // 0
    await s.tickOnce(); // +20 → conflict resolved (>10)
    expect(db.listConflicts()).toHaveLength(0);
    await s.tickOnce(); // +40
    await s.tickOnce(); // +60 → ally
    expect(db.getRelationship(a.id, b.id)!.status).toBe("ally");
    expect(posts.some((p) => p.t.includes("formed an alliance") && p.t.includes("emergent"))).toBe(true);
  });

  it("conflict partners get picked more often", async () => {
    const { db, society, director } = mk();
    const [a, b] = seedTwins(db, 4);
    director.addConflict(a, b, "test feud");
    let hits = 0;
    for (let i = 0; i < 15; i++) {
      await society.tickOnce();
      const last = db.listInteractions(1)[0];
      const pair = [last.aId, last.bId].sort().join("|");
      if (pair === [a.id, b.id].sort().join("|")) hits++;
    }
    expect(hits).toBeGreaterThanOrEqual(2);
  });
});

describe("rumors + memories", () => {
  it("passes rumor speaker->listener with source and dedupes", async () => {
    const chat = async () => '{"say":"heard it","intent":"gossip","delta":0,"memory":"office gossip"}';
    const { db, society } = mk({ chat });
    const [a, b] = seedTwins(db, 2);
    society.recordRumor(a.id, "the coffee budget got cut", "test");
    await society.tickOnce();
    const rumors = db.getMemories(b.id, "rumor");
    expect(rumors).toHaveLength(1);
    expect(rumors[0].text).toBe("the coffee budget got cut");
    expect(rumors[0].source).toBe("Ada");
    await society.tickOnce();
    expect(db.getMemories(b.id, "rumor")).toHaveLength(1);
    // bounced back to a? deduped there too
    expect(db.getMemories(a.id, "rumor")).toHaveLength(1);
  });

  it("caps memories at 60 and interactions at 300", async () => {
    const { db } = mk();
    for (let i = 0; i < 70; i++)
      db.addMemory({ id: `m${i}`, personaId: "p", ts: `t${i}`, text: `mem ${i}`, kind: "chat", importance: 3 });
    expect(db.getMemories("p")).toHaveLength(60);
    for (let i = 0; i < 310; i++)
      db.addInteraction({ id: `i${i}`, ts: `t${String(i).padStart(4, "0")}`, aId: "a", bId: "b", summary: "s", intent: "share", delta: 0 });
    expect(db.listInteractions(400)).toHaveLength(300);
  });

  it("sanitizes all model text", async () => {
    const chat = async () => '{"say":"mail me at jane@corp.com","intent":"share","delta":0,"memory":"jane@corp.com said hi"}';
    const { db, society, posts } = mk({ chat });
    seedTwins(db, 2);
    await society.tickOnce();
    const out = JSON.stringify(posts) + JSON.stringify(db.getMemories(db.listTwins()[0].id));
    expect(out).not.toContain("jane@corp.com");
    expect(out).toContain("[redacted-email]");
  });
});

describe("reflection", () => {
  it("proposes a goal only when the persona has none", async () => {
    const posts: any[] = [];
    const db = createDb(":memory:");
    const director = createDirector({ db: db as any, post: (p, k, t) => posts.push({ p, k, t }) });
    const chat = async (msgs: any[]) =>
      msgs[0].content.includes("Reflect briefly")
        ? '{"reflection":"I should collaborate more","goal":"Pair with someone weekly"}'
        : '{"say":"hi","intent":"agree","delta":1,"memory":"m"}';
    const s = createSociety({
      db, chat, post: (p: string, k: any, t: string) => posts.push({ p, k, t }),
      director, facts: () => [], whisper: () => undefined, viewers: () => 1,
      sleep: () => Promise.resolve(), rng: seeded(7), maxCallsPerMin: 100,
    });
    seedTwins(db, 2);
    for (let i = 0; i < 6; i++) await s.tickOnce();
    const goals = db.listGoals();
    expect(goals.length).toBeGreaterThan(0);
    expect(goals[0].title).toContain("Pair with someone");
    expect(posts.some((p) => p.t.includes("decided to") && p.t.includes("emergent"))).toBe(true);
    const goalCount = db.listGoals().length;
    for (let i = 0; i < 6; i++) await s.tickOnce();
    expect(db.listGoals().length).toBe(goalCount); // no duplicates
  });
});

describe("offline fallback", () => {
  it("produces emergent relationships within 30 ticks", async () => {
    const { db, society } = mk({ rng: seeded(99) });
    seedTwins(db, 4);
    for (let i = 0; i < 30; i++) await society.tickOnce();
    const rels = db.listRelationships();
    expect(rels.length).toBeGreaterThan(0);
    expect(rels.some((r) => r.status === "ally" || r.status === "rival" || Math.abs(r.affinity) >= 30)).toBe(true);
  });
});

describe("pulse + profileFor", () => {
  it("returns the documented shapes", async () => {
    const { db, society } = mk();
    const [a, b] = seedTwins(db, 4);
    society.recordEvent("Big news: office move announced");
    await society.tickOnce();
    const pulse = society.pulse();
    expect(pulse).toHaveProperty("interactions10m");
    expect(pulse).toHaveProperty("interactionsTotal");
    expect(pulse).toHaveProperty("alliances");
    expect(pulse).toHaveProperty("rivalries");
    expect(pulse).toHaveProperty("factions");
    expect(pulse).toHaveProperty("topTopics");
    expect(pulse).toHaveProperty("rumors");
    expect(pulse).toHaveProperty("mood");
    expect(pulse).toHaveProperty("watching", true);
    expect(pulse).toHaveProperty("llmCallsLastMin");
    const prof = society.profileFor(a.id);
    expect(prof).toHaveProperty("relationships");
    expect(prof).toHaveProperty("memories");
    expect(prof).toHaveProperty("interactions");
    expect(prof.memories.some((m) => m.kind === "event" && m.text.includes("office move"))).toBe(true);
  });
});

describe("bus.history()", () => {
  it("does not add subscribers", () => {
    const bus = createBus();
    for (let i = 0; i < 5; i++) bus.history();
    let calls = 0;
    bus.subscribe(() => calls++);
    bus.publish({ personaId: "x", kind: "post", text: "hi" }, () => "n");
    expect(calls).toBe(1);
    expect(bus.history()).toHaveLength(1);
  });
});

describe("demo world chat", () => {
  const docker = {
    createContainer: vi.fn(async () => ({ id: "c", start: vi.fn(), inspect: vi.fn(async () => ({ NetworkSettings: { Ports: {} } })) })),
    getContainer: vi.fn(() => ({ kill: vi.fn(), remove: vi.fn(), logs: vi.fn() })),
  } as any;
  const env = { MODEL_BASE_URL: "", MODEL_NAME: "x", MODEL_API_KEY: "" };
  const DEMO = { ipCap: 3, maxTwins: 40, chatMsgCap: 30, adminToken: "t" };
  const V = (r: request.Test) => r.set("x-visitor-id", "v1").set("x-visitor-ip", "1.1.1.1");

  it("converts banned actions into a visitor inject (no refusal)", async () => {
    const db = createDb(":memory:");
    db.saveTwin(mkTwin("s0", "Ada"));
    const chat = async () => 'Sure! <world_action>{"type":"remove","persona":"Ada"}</world_action>';
    const app = createApp({ db, docker, agentImage: "img", modelEnv: env, chat, demo: DEMO });
    const server = app.listen(0);
    const port = (server.address() as any).port;
    try {
      await V(request(app).post("/world/chat")).send({ messages: [{ role: "user", content: "remove Ada please" }] });
      await new Promise((r) => setTimeout(r, 100));
      const res = await fetch(`http://localhost:${port}/world/feed`);
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      const events: any[] = [];
      let buf = "";
      while (events.length < 2) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const p of parts) {
          const m = p.match(/^data: (.*)$/s);
          if (m) { try { events.push(JSON.parse(m[1])); } catch {} }
        }
      }
      reader.cancel();
      const texts = events.map((e) => e.text).join("\n");
      expect(texts).not.toContain("isn't available");
      expect(texts).toContain("remove Ada please");
      // Ada is still in the world — the remove never executed
      expect(db.listTwins()).toHaveLength(1);
    } finally {
      server.close();
    }
  });
});
