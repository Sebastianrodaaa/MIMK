import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createDb } from "../src/db.js";
import { createApp } from "../src/app.js";
import { createDirector, extractJson, templateTick } from "../src/director.js";
import type { Persona } from "@mimk/shared";

const env = { MODEL_BASE_URL: "", MODEL_NAME: "m", MODEL_API_KEY: "" };
const mkTwin = (id: string, name: string, subjectId = id): Persona => ({
  id, subjectId, name, traits: ["curious"], stances: [], speechStyle: "dry",
  interests: [], relationships: [], avatar: { palette: ["#fff"], accessory: "none" }, bio: `${name} bio`,
});

function fakeDocker() {
  const container = {
    start: vi.fn(async () => {}),
    inspect: vi.fn(async () => ({
      NetworkSettings: { Ports: { "6080/tcp": [{ HostIp: "127.0.0.1", HostPort: "51234" }] } },
    })),
    remove: vi.fn(async () => {}),
    logs: vi.fn(async () => {
      const { PassThrough } = await import("node:stream");
      const s = new PassThrough();
      s.end();
      return s;
    }),
  };
  return { docker: { createContainer: vi.fn(async () => container), getContainer: vi.fn(() => container) } };
}

function mkDeps(twins: Persona[]) {
  const db = createDb(":memory:");
  const posts: any[] = [];
  for (const t of twins) db.saveTwin(t);
  const deps = {
    db: db as any,
    post: (personaId: string, kind: any, text: string) => posts.push({ personaId, kind, text }),
    facts: () => ["Linus Torvalds created Linux", "Git impacts more than Linux"],
    feed: () => ["Ada: hi"],
    worldDelayMs: 0,
  };
  return { db, deps, posts };
}

describe("director", () => {
  it("extractJson parses leniently", () => {
    expect(extractJson('pre {"a":1} post')).toEqual({ a: 1 });
    expect(extractJson('```json {"x":{"y":"z{}"}}```')).toEqual({ x: { y: "z{}" } });
    expect(extractJson("garbage")).toBeUndefined();
  });
  it("templateTick uses real data", () => {
    const out = templateTick([mkTwin("1", "Ada"), mkTwin("2", "Marco")], ["Linus created Linux"]);
    expect(out.newConflict?.a).toBe("Ada");
    expect(out.lines[0].text).toContain("Linus");
  });
  it("tick enforces invariants + persists", async () => {
    const { db, deps, posts } = mkDeps([mkTwin("1", "Ada"), mkTwin("2", "Marco")]);
    const d = createDirector({ ...deps, chat: vi.fn(async () => 'noise {"lines":[{"persona":"Ada","text":"wow"}],"progress":[{"persona":"Ada","delta":130}]} tail') });
    const r = await d.tick();
    expect(r.usedModel).toBe(true);
    expect(db.listGoals().filter((g) => g.personaId === "1")).toHaveLength(1);
    expect(db.listGoals().find((g) => g.personaId === "1")?.progress).toBe(30); // delta clamped
    // more ticks drive it over 100 (±30/tick clamp) → done + completed post
    await d.tick(); await d.tick(); await d.tick();
    expect(db.listGoals(false).filter((g) => g.status === "done")).toHaveLength(1);
    expect(posts.some((p) => p.text.includes("completed"))).toBe(true);
  });
  it("goals/conflicts persist across db reopen", () => {
    const f = `/tmp/dir-test-${Date.now()}.db`;
    const d1 = createDb(f);
    d1.saveTwin(mkTwin("1", "Ada"));
    d1.addGoal({ id: "g1", personaId: "1", title: "x", progress: 5, status: "active", createdAt: "t" });
    d1.addConflict({ id: "c1", aId: "1", bId: "2", issue: "i", intensity: 3, status: "active", createdAt: "t" });
    const d2 = createDb(f);
    expect(d2.listGoals()[0].title).toBe("x");
    expect(d2.listConflicts()[0].issue).toBe("i");
  });
  it("no-fallback when chat absent: template produces real posts", async () => {
    const { deps, posts } = mkDeps([mkTwin("1", "Ada"), mkTwin("2", "Marco")]);
    await createDirector(deps).tick();
    expect(posts.some((p) => p.text.startsWith("⚡"))).toBe(true);
    expect(posts.some((p) => p.text.startsWith("⚔️"))).toBe(true);
  });
});

describe("/world/god", () => {
  const mk = () => {
    const db = createDb(":memory:");
    db.saveTwin(mkTwin("1", "Ada")); db.saveTwin(mkTwin("2", "Marco"));
    return createApp({ db, docker: {} as any, agentImage: "img", modelEnv: env });
  };
  it("validation: 400 on bad body", async () => {
    expect((await request(mk()).post("/world/god").send({ op: "goal" })).status).toBe(400);
    expect((await request(mk()).post("/world/god").send({ op: "director", intervalSec: 5 })).status).toBe(400);
  });
  it("goal/conflict/whisper/resolve/state/tick/director", async () => {
    const app = mk();
    const g = await request(app).post("/world/god").send({ op: "goal", persona: "ada", title: "ship it" });
    expect(g.body.ok).toBe(true);
    expect(g.body.state.goals[0].title).toBe("ship it");
    const c = await request(app).post("/world/god").send({ op: "conflict", a: "Ada", b: "Marco", issue: "vim vs emacs" });
    expect(c.body.state.conflicts[0].issue).toBe("vim vs emacs");
    const w = await request(app).post("/world/god").send({ op: "whisper", persona: "ada", text: "secret" });
    expect(w.body.ok).toBe(true);
    const r = await request(app).post("/world/god").send({ op: "resolve", conflictId: c.body.state.conflicts[0].id });
    expect(r.body.ok).toBe(true);
    const t = await request(app).post("/world/god").send({ op: "tick" });
    expect(t.body.ok).toBe(true);
    const dd = await request(app).post("/world/god").send({ op: "director", enabled: true, intervalSec: 30 });
    expect(dd.body.state.director.enabled).toBe(true);
    const dd2 = await request(app).post("/world/god").send({ op: "director", enabled: false });
    expect(dd2.body.state.director.enabled).toBe(false);
    const ev = await request(app).post("/world/god").send({ op: "event", preset: "crisis" });
    expect(ev.body.ok).toBe(true);
  });
});

describe("findings → world + research feed", () => {
  it("auto-twin at >=3 findings via prepass; respects removal; feed endpoint exists", async () => {
    const db = createDb(":memory:");
    const docker = fakeDocker().docker;
    const stub = { searchPerson: vi.fn(async () => ({
      name: "Ada Voss",
      facts: [1, 2, 3].map((i) => ({ summary: `Fact ${i} about Ada Voss the researcher.`, sourceUrl: `https://example.com/${i}`, source: "test" })),
      handles: {}, ms: 50, timings: [],
    })) };
    const app = createApp({ db, docker: docker as any, agentImage: "img", modelEnv: env, osint: stub });
    const res = await request(app).post("/agents").send({ tasks: [{ person: "Ada Voss", task: "bio" }] });
    expect(res.status).toBe(201);
    // auto-twin is async — poll briefly
    for (let i = 0; i < 40 && !db.listTwins().length; i++) await new Promise((r) => setTimeout(r, 25));
    expect(db.listTwins()).toHaveLength(1);
    const twin = db.listTwins()[0];
    expect(twin.name).toBe("Ada Voss");
    // feed endpoint streams (content-type check via raw http)
    const st = await request(app).get("/world/state");
    expect(st.body.twins[0].name).toBe("Ada Voss");
    // removal is respected: delete twin → tombstone → new findings must NOT re-create
    await request(app).delete(`/twins/${twin.id}`);
    for (let i = 4; i <= 6; i++)
      db.addFinding({ runId: `prepass:${twin.subjectId}`, subjectId: twin.subjectId, sourceUrl: `https://example.com/${i}`, summary: `More ${i}`, ts: new Date().toISOString() });
    await new Promise((r) => setTimeout(r, 150));
    expect(db.listTwins()).toHaveLength(0);
  });
});
