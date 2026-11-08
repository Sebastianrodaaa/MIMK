import { describe, expect, it, vi } from "vitest";
import { createSimEpochs } from "../src/epochs.js";
import { createDb } from "../src/db.js";
import { createSociety } from "../src/society.js";
import { createDirector } from "../src/director.js";
import { mirofishLazy } from "../src/sim.js";
import { fixturePersona, buildDossier } from "@mimk/twin";
import type { Persona } from "@mimk/shared";

const mkTwin = (id: string, name: string): Persona => {
  const p = fixturePersona(id, name, buildDossier(id, []));
  return p;
};

const mk = (over: any = {}) => {
  const db = createDb(":memory:");
  const posts: any[] = [];
  const nowRef = { t: 0 };
  const director = createDirector({ db: db as any, post: (p, k, t) => posts.push({ p, k, t }) });
  const society = over.society === false ? undefined : createSociety({
    db,
    post: (p: string, k: any, t: string, tgt?: string) => posts.push({ p, k, t, tgt }),
    director, facts: () => [], whisper: () => undefined, viewers: () => 0,
    sleep: () => Promise.resolve(), rng: () => 0.5, maxCallsPerMin: 100,
  });
  const sim = over.sim ?? {
    start: vi.fn(async () => "started"),
    waitReady: vi.fn(async () => true),
    waitDone: vi.fn(async () => ({ posts: 7 })),
    isActive: () => false,
    seedDocument: () => "", events: async function* () {},
  };
  const epochs = createSimEpochs({
    sim, db, society,
    post: (p, k, t) => posts.push({ p, k, t }),
    viewers: () => over.viewersNow ?? 1,
    now: () => nowRef.t,
    config: { minGapMin: over.minGapMin ?? 30, maxPerDay: over.maxPerDay ?? 2, rounds: 2, minTwins: 3, waitReadyMs: 1000 },
    ...(over.checkMs !== undefined ? { checkMs: over.checkMs } : {}),
  });
  return { db, posts, society, sim, epochs, nowRef };
};
const seed = (db: any, n = 4) => { for (let i = 0; i < n; i++) db.saveTwin(mkTwin(`s${i}`, `T${i}`)); };

describe("epoch gating", () => {
  it("no epoch with 0 viewers, <3 twins, inside minGap, over maxPerDay", async () => {
    // 0 viewers
    let m = mk({ viewersNow: 0 });
    seed(m.db);
    m.epochs.check();
    await new Promise((r) => setTimeout(r, 10));
    expect(m.sim.start).not.toHaveBeenCalled();

    // <3 twins
    m = mk();
    seed(m.db, 2);
    m.epochs.check();
    await new Promise((r) => setTimeout(r, 10));
    expect(m.sim.start).not.toHaveBeenCalled();

    // inside minGap
    m = mk({ minGapMin: 30 });
    seed(m.db);
    m.db.setWorldState("epoch.lastAt", "0");
    m.nowRef.t = 5 * 60000; // 5 min later, gap is 30
    m.epochs.check();
    await new Promise((r) => setTimeout(r, 10));
    expect(m.sim.start).not.toHaveBeenCalled();

    // over maxPerDay
    m = mk({ maxPerDay: 2 });
    seed(m.db);
    const day = new Date(0).toISOString().slice(0, 10);
    m.db.setWorldState(`epoch.count.${day}`, "2");
    m.epochs.check();
    await new Promise((r) => setTimeout(r, 10));
    expect(m.sim.start).not.toHaveBeenCalled();
  });

  it("caps survive a new instance via db state", async () => {
    const m = mk();
    seed(m.db);
    const day = new Date(0).toISOString().slice(0, 10);
    m.db.setWorldState(`epoch.count.${day}`, "2");
    m.db.setWorldState("epoch.lastAt", String(40 * 60000));
    m.nowRef.t = 41 * 60000;
    // brand-new epochs instance on the same db
    const epochs2 = createSimEpochs({
      sim: m.sim, db: m.db, society: m.society,
      post: () => {}, viewers: () => 1, now: () => m.nowRef.t,
      config: { minGapMin: 30, maxPerDay: 2, rounds: 2, minTwins: 3 },
    });
    epochs2.check();
    await new Promise((r) => setTimeout(r, 10));
    expect(m.sim.start).not.toHaveBeenCalled();
  });
});

describe("epoch run", () => {
  it("scenario text includes interactions, conflicts, events", async () => {
    const m = mk();
    seed(m.db);
    const [a, b] = m.db.listTwins();
    m.db.addInteraction({ id: "i1", ts: "t", aId: a.id, bId: b.id, summary: "debated kernels", intent: "disagree", delta: -3 });
    m.db.addConflict({ id: "c1", aId: a.id, bId: b.id, issue: "kernel design", intensity: 3, status: "active", createdAt: "t" });
    m.society!.recordEvent("office move announced");
    const text = m.epochs.scenarioText();
    expect(text).toContain("Continuing community dynamics");
    expect(text).toContain("debated kernels");
    expect(text).toContain("kernel design");
    expect(text).toContain("office move announced");
  });

  it("waits for cold start then runs, records caps + god posts", async () => {
    const m = mk();
    seed(m.db);
    await m.epochs.runEpoch();
    expect(m.sim.waitReady).toHaveBeenCalled();
    expect(m.sim.start).toHaveBeenCalled();
    expect(m.posts.some((p) => p.t.includes("epoch started"))).toBe(true);
    expect(m.posts.some((p) => p.t.includes("epoch finished (7 posts)"))).toBe(true);
    expect(m.epochs.state().epochsToday).toBe(1);
    expect(m.epochs.state().lastPosts).toBe(7);
    expect(m.epochs.state().state).toBe("idle");
  });

  it("give-up path: unavailable + consumes minGap", async () => {
    const m = mk({ sim: { start: vi.fn(), waitReady: vi.fn(async () => false), seedDocument: () => "", events: async function* () {} } });
    seed(m.db);
    await m.epochs.runEpoch();
    expect(m.epochs.state().state).toBe("unavailable");
    expect(m.posts.some((p) => p.t.includes("unavailable, skipping"))).toBe(true);
    expect(m.db.getWorldState("epoch.lastAt")).toBe("0");
    // second check inside minGap: no new attempt
    m.epochs.check();
    await new Promise((r) => setTimeout(r, 10));
    expect(m.sim.waitReady).toHaveBeenCalledTimes(1);
  });

  it("never throws out of runEpoch", async () => {
    const m = mk({ sim: { start: vi.fn(async () => { throw new Error("boom"); }), waitReady: vi.fn(async () => true), seedDocument: () => "", events: async function* () {} } });
    seed(m.db);
    await expect(m.epochs.runEpoch()).resolves.toBeUndefined();
  });
});

describe("event ingestion", () => {
  it("posts seed rumor memories; targeted actions nudge affinity to thresholds", async () => {
    const m = mk();
    seed(m.db);
    const [a, b] = m.db.listTwins();
    m.epochs.ingestEvent({ personaId: a.id, kind: "post", text: "big announcement from the square" });
    const rumors = m.db.getMemories(b.id, "rumor");
    expect(rumors.some((r) => r.text.includes("big announcement") && r.source === "town square")).toBe(true);
    // 25 likes => +50 affinity => alliance + emergent post
    for (let i = 0; i < 25; i++)
      m.epochs.ingestEvent({ personaId: a.id, kind: "like", text: "like", targetId: b.id });
    expect(m.db.getRelationship(a.id, b.id)!.status).toBe("ally");
    expect(m.posts.some((p) => p.t.includes("formed an alliance"))).toBe(true);
    // ignores unknown actors/targets without throwing
    expect(() => m.epochs.ingestEvent({ personaId: "ghost", kind: "post", text: "x" })).not.toThrow();
  });
});

describe("lazy mode flag", () => {
  it("mirofishLazy only on MIROFISH_LAZY=1", () => {
    expect(mirofishLazy({ MIROFISH_LAZY: "1" })).toBe(true);
    expect(mirofishLazy({})).toBe(false);
    expect(mirofishLazy({ MIROFISH_LAZY: "0" })).toBe(false);
  });
});
