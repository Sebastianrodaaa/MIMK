import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp, type Deps } from "../src/app.js";
import { createDb } from "../src/db.js";
import { fixturePersona, buildDossier } from "@mimk/twin";

const fakeContainer = {
  id: "c123",
  start: vi.fn(async () => {}),
  kill: vi.fn(),
  remove: vi.fn(),
  inspect: vi.fn(async () => ({
    NetworkSettings: { Ports: { "6080/tcp": [{ HostPort: "49153" }] } },
  })),
};
const docker = {
  createContainer: vi.fn(async () => fakeContainer),
  getContainer: vi.fn(() => fakeContainer),
} as any;

const env = { MODEL_BASE_URL: "http://x", MODEL_NAME: "holo", MODEL_API_KEY: "k" };
const DEMO = { ipCap: 2, maxTwins: 40, chatMsgCap: 30, adminToken: "s3cret" };

const mk = (over: Partial<Deps> = {}, demo: Deps["demo"] | null = DEMO) => {
  const db = createDb(":memory:");
  const app = createApp({ db, docker, agentImage: "img", modelEnv: env, ...over, ...(demo ? { demo } : {}) });
  return { app, db };
};
const vid = (r: request.Test, id: string, ip = "10.0.0.1") =>
  r.set("x-visitor-id", id).set("x-visitor-ip", ip);
const admin = (r: request.Test) => r.set("x-admin-token", "s3cret");

const chat1 = { messages: [{ role: "user", content: "Tell me about Ada Voss" }] };

describe("demo mode: chat→twin quotas", () => {
  it("visitor creates one agent; second attempt and further chat blocked", async () => {
    const { app } = mk();
    const r1 = await vid(request(app).post("/twins/from-chat"), "A").send(chat1);
    expect(r1.status).toBe(201);
    expect(r1.body.name).toBe("Ada Voss");
    expect(r1.body.id).toBeTruthy();

    const r2 = await vid(request(app).post("/twins/from-chat"), "A").send(chat1);
    expect(r2.status).toBe(403);
    expect(r2.body.code).toBe("already_created");

    const c = await vid(request(app).post("/chat"), "A").send(chat1);
    expect(c.status).toBe(403);
    expect(c.body.code).toBe("already_created");

    const me = await vid(request(app).get("/demo/me"), "A");
    expect(me.body.demo).toBe(true);
    expect(me.body.hasAgent).toBe(true);
    expect(me.body.canChat).toBe(false);
    expect(me.body.twinName).toBe("Ada Voss");
  });

  it("enforces ip cap across different visitors on one ip", async () => {
    const { app } = mk();
    expect((await vid(request(app).post("/twins/from-chat"), "A", "1.2.3.4").send(chat1)).status).toBe(201);
    expect((await vid(request(app).post("/twins/from-chat"), "B", "1.2.3.4").send(chat1)).status).toBe(201);
    const r3 = await vid(request(app).post("/twins/from-chat"), "C", "1.2.3.4").send(chat1);
    expect(r3.status).toBe(403);
    expect(r3.body.code).toBe("ip_cap");
    // other ip unaffected
    expect((await vid(request(app).post("/twins/from-chat"), "D", "9.9.9.9").send(chat1)).status).toBe(201);
  });

  it("enforces world cap", async () => {
    const { app, db } = mk({}, { ...DEMO, maxTwins: 1 });
    db.saveTwin(fixturePersona("s1", "Existing", buildDossier("s1", [])));
    const r = await vid(request(app).post("/twins/from-chat"), "A").send(chat1);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("world_full");
    const me = await vid(request(app).get("/demo/me"), "A");
    expect(me.body.worldFull).toBe(true);
  });

  it("enforces the chat message cap", async () => {
    const { app } = mk({}, { ...DEMO, chatMsgCap: 1 });
    const r1 = await vid(request(app).post("/chat"), "A").send(chat1);
    expect(r1.status).toBe(200);
    const r2 = await vid(request(app).post("/chat"), "A").send(chat1);
    expect(r2.status).toBe(403);
    expect(r2.body.code).toBe("chat_cap");
    const me = await vid(request(app).get("/demo/me"), "A");
    expect(me.body.chatMsgsLeft).toBe(0);
    expect(me.body.canChat).toBe(false);
  });
});

describe("demo mode: read-only world", () => {
  it("blocks destructive and god-mode ops for visitors, allows admin", async () => {
    const { app, db } = mk();
    const twin = fixturePersona("s1", "Ada", buildDossier("s1", []));
    db.saveTwin(twin);

    expect((await vid(request(app).delete("/twins"), "A")).status).toBe(403);
    expect((await vid(request(app).delete(`/twins/${twin.id}`), "A")).status).toBe(403);
    expect((await vid(request(app).post("/subjects"), "A").send({ type: "public_figure", name: "X", approvedSources: ["w"], consent: true })).status).toBe(403);
    expect((await vid(request(app).post("/runs"), "A").send({ subjectId: "s1" })).status).toBe(403);
    expect((await vid(request(app).post("/sim/start"), "A").send({})).status).toBe(403);

    expect((await vid(request(app).post("/world/god"), "A").send({ op: "event", text: "hello world" })).status).toBe(200);
    const g = await vid(request(app).post("/world/god"), "A").send({ op: "goal", persona: "Ada", title: "x" });
    expect(g.status).toBe(403);
    expect(g.body.code).toBe("read_only");
    expect((await vid(request(app).post("/world/god"), "A").send({ op: "director", enabled: false })).status).toBe(403);

    expect((await vid(request(app).post("/world/chat"), "A").send({ messages: [{ role: "user", content: "announce free pizza" }] })).status).toBe(200);
    expect((await vid(request(app).post("/sim/inject"), "A").send({ text: "hi" })).status).toBe(200);
    expect((await vid(request(app).post(`/twins/${twin.id}/chat`), "A").send({ message: "hi" })).status).toBe(200);

    // admin bypasses everything
    expect((await admin(request(app).post("/world/god")).send({ op: "director", enabled: false })).status).toBe(200);
    expect((await admin(request(app).post("/subjects")).send({ type: "public_figure", name: "X", approvedSources: ["w"], consent: true })).status).toBe(201);
    expect((await admin(request(app).delete(`/twins/${twin.id}`))).status).toBe(200);
    expect((await admin(request(app).delete("/twins"))).status).toBe(200);
    // wrong token is not admin
    expect((await vid(request(app).delete("/twins"), "A").set("x-admin-token", "wrong")).status).toBe(403);
  });

  it("requires a visitor id on mutating requests", async () => {
    const { app } = mk();
    expect((await request(app).post("/chat").send(chat1)).status).toBe(403);
    expect((await request(app).post("/world/god").send({ op: "event", text: "x" })).status).toBe(403);
    expect((await request(app).post("/twins/from-chat").send(chat1)).status).toBe(403);
    // GETs are fine without one
    expect((await request(app).get("/demo/me")).status).toBe(200);
    expect((await request(app).get("/twins")).status).toBe(200);
  });

  it("does not auto-create twins from findings in demo mode", async () => {
    const db = createDb(":memory:");
    const stub = { searchPerson: vi.fn(async () => ({
      name: "Ada Voss",
      facts: [1, 2, 3].map((i) => ({ summary: `Fact ${i} about Ada Voss.`, sourceUrl: `https://example.com/${i}`, source: "test" })),
      handles: {}, ms: 50, timings: [],
    })) };
    const app = createApp({ db, docker, agentImage: "img", modelEnv: env, osint: stub, demo: DEMO });
    const res = await vid(request(app).post("/agents"), "A").send({ tasks: [{ person: "Ada Voss", task: "bio" }] });
    expect(res.status).toBe(201);
    for (let i = 0; i < 60 && db.getFindings(db.listSubjects()[0]?.id ?? "").length < 3; i++)
      await new Promise((r) => setTimeout(r, 25));
    await new Promise((r) => setTimeout(r, 150));
    expect(db.getFindings(db.listSubjects()[0].id).length).toBeGreaterThanOrEqual(3);
    expect(db.listTwins()).toHaveLength(0);
    // but the visitor↔subject link was recorded for from-chat dossier reuse
    expect(db.listVisitorSubjects("A")).toContain(db.listSubjects()[0].id);
  });
});

describe("demo off: regression", () => {
  it("nothing is blocked and from-chat needs no quota", async () => {
    const { app, db } = mk({}, null);
    const r1 = await request(app).post("/twins/from-chat").send(chat1);
    expect(r1.status).toBe(201);
    const r2 = await request(app).post("/twins/from-chat").send(chat1);
    expect(r2.status).toBe(201);
    expect((await request(app).post("/chat").send(chat1)).status).toBe(200);
    expect((await request(app).delete(`/twins/${r1.body.id}`)).status).toBe(200);
    expect((await request(app).get("/demo/me")).body.demo).toBe(false);
    expect(db.listTwins().length).toBe(1);
  });
});

describe("GET /twins/:id/profile", () => {
  it("returns profile shape and 404 for unknown twin", async () => {
    const { app, db } = mk();
    db.addSubject({ id: "s1", type: "public_figure", name: "Ada", approvedSources: ["w"], consent: true, consentedAt: "", handles: [], createdAt: "" });
    db.addFinding({ runId: "r", subjectId: "s1", sourceUrl: "https://x/1", summary: "Ada builds things", ts: "t" });
    const twin = fixturePersona("s1", "Ada", buildDossier("s1", db.getFindings("s1")));
    db.saveDossier(buildDossier("s1", db.getFindings("s1")));
    db.saveTwin(twin);

    const res = await vid(request(app).get(`/twins/${twin.id}/profile`), "A");
    expect(res.status).toBe(200);
    expect(res.body.persona.name).toBe("Ada");
    expect(res.body.dossier.facts[0].claim).toContain("Ada builds things");
    expect(res.body.findings[0].summary).toContain("Ada builds things");
    expect(res.body).toHaveProperty("goals");
    expect(res.body).toHaveProperty("conflicts");
    expect(res.body).toHaveProperty("recent");
    expect(JSON.stringify(res.body)).not.toContain("10.0.0.1");

    expect((await vid(request(app).get("/twins/nope/profile"), "A")).status).toBe(404);
  });
});
