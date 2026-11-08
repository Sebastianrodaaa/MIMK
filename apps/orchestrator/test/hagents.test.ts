import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createClient, buildTask, HError } from "../src/hagents.js";
import { mapHEvent, persistAnswer, subscribe, getBuffer } from "../src/hcollector.js";
import { createDb } from "../src/db.js";
import { createApp } from "../src/app.js";

const cfg = { baseUrl: "https://x/api/v2", apiKey: "k", agent: "a", maxSteps: 5, maxTimeS: 60 };
const subject: any = {
  id: "s1", type: "public_figure", name: "Test Person",
  approvedSources: ["wikipedia"], consent: true, consentedAt: "t", handles: [], createdAt: "t",
};

function mockFetch(handler: (url: string, init: any) => { status: number; body?: any }) {
  return (async (url: any, init: any) => {
    const r = handler(String(url), init);
    return {
      status: r.status, ok: r.status >= 200 && r.status < 300,
      text: async () => (r.body === undefined ? "" : JSON.stringify(r.body)),
    } as any;
  }) as typeof fetch;
}

describe("hagents client", () => {
  it("creates a session with task + answer schema", async () => {
    let seen: any;
    const c = createClient(cfg, mockFetch((_u, i) => {
      seen = JSON.parse(i.body);
      return { status: 201, body: { id: "sess-1", agent_view_url: "https://platform.hcompany.ai/x" } };
    }));
    const res: any = await c.createSession(subject, buildTask(subject, { categories: {} }));
    expect(res.id).toBe("sess-1");
    expect(seen.agent).toBe("a");
    expect(seen.max_steps).toBe(5);
    expect(seen.overrides["agent.answer_format"].required).toEqual(["summary", "findings"]);
  });
  it("throws readable error on 429", async () => {
    const c = createClient(cfg, mockFetch(() => ({ status: 429, body: { error: "busy" } })));
    await expect(c.createSession(subject, "t")).rejects.toThrow(/rate limited/);
  });
  it("throws readable error on 422", async () => {
    const c = createClient(cfg, mockFetch(() => ({ status: 422, body: { error: "bad override" } })));
    await expect(c.createSession(subject, "t")).rejects.toThrow(/unprocessable.*bad override/);
  });
  it("paginates changes: 204 null vs 200 with events", async () => {
    const c = createClient(cfg, mockFetch((u) =>
      u.includes("from_index=0") ? { status: 204 } : { status: 200, body: { status: "running", new_events: [{ type: "AgentErrorEvent", data: {} }], first_index: 0 } }));
    expect(await c.getChanges("s", 0)).toBeNull();
    const res: any = await c.getChanges("s", 5);
    expect(res.new_events).toHaveLength(1);
  });
});

describe("mapHEvent", () => {
  it("maps policy_event to action", () => {
    const e = mapHEvent("r1", { type: "AgentEvent", timestamp: "t", data: { kind: "policy_event", content: "thinking", tool_reqs: [{ tool_name: "browser" }] } });
    expect(e?.kind).toBe("action");
    expect((e?.data as any).tool_reqs[0].tool_name).toBe("browser");
  });
  it("maps observation_event to screenshot", () => {
    const e = mapHEvent("r1", { type: "AgentEvent", timestamp: "t", data: { kind: "observation_event", image: { source: "https://img" }, metadata: { url: "https://p", title: "T" } } });
    expect(e?.kind).toBe("screenshot");
    expect((e?.data as any).url).toBe("https://img");
  });
  it("maps LiveViewUrlEvent to log", () => {
    expect(mapHEvent("r1", { type: "LiveViewUrlEvent", data: { live_view_url: "https://lv" } })?.kind).toBe("log");
  });
});

describe("persistAnswer + buffer", () => {
  it("persists findings w/ filterSensitive and emits finding events", () => {
    const db = createDb(":memory:");
    const run: any = { id: "r1", subjectId: "s1" };
    const sub = subscribe("r1", () => {});
    persistAnswer(run, { findings: [
      { sourceUrl: "https://a", summary: "email me at x@y.com" },
      { sourceUrl: "https://a", summary: "email me at x@y.com" },
      { sourceUrl: "https://b", summary: "clean fact" },
    ]}, db);
    expect(db.getFindings("s1")).toHaveLength(2);
    expect(db.getFindings("s1")[0].summary).toContain("[redacted-email]");
    expect(getBuffer("r1").events.filter((e) => e.kind === "finding")).toHaveLength(3);
    sub.close();
  });
});

describe("SSE replay for h runs", () => {
  it("replays buffered events", async () => {
    const db = createDb(":memory:");
    db.addSubject(subject);
    db.addRun({ id: "rh", subjectId: "s1", status: "running", backend: "h", hSessionId: "sess", createdAt: "t" });
    persistAnswer({ id: "rh", subjectId: "s1" } as any, { findings: [{ sourceUrl: "u", summary: "f" }] }, db);
    const app = createApp({ db, docker: {} as any, agentImage: "img", modelEnv: { MODEL_BASE_URL: "", MODEL_NAME: "m", MODEL_API_KEY: "" } });
    const server = app.listen(0);
    const port = (server.address() as any).port;
    const res = await fetch(`http://localhost:${port}/runs/rh/events`);
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    server.close();
    expect(new TextDecoder().decode(value)).toContain('"kind":"finding"');
  });
});

describe("start-all with backend h", () => {
  it("spawns h sessions up to MAX_PARALLEL", async () => {
    const db = createDb(":memory:");
    db.addSubject(subject);
    db.addSubject({ ...subject, id: "s2", name: "Second" });
    const createSession = vi.fn(async () => ({ id: "sess", agent_view_url: "u" }));
    const hClient = { createSession, getChanges: vi.fn(async () => ({ status: "running", new_events: [], first_index: 0 })), cancelSession: vi.fn() } as any;
    const app = createApp({ db, docker: {} as any, agentImage: "img", modelEnv: { MODEL_BASE_URL: "", MODEL_NAME: "m", MODEL_API_KEY: "" }, hClient, maxParallel: 1 });
    const res = await request(app).post("/runs/start-all").send({ backend: "h" });
    expect(res.status).toBe(201);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].backend).toBe("h");
    expect(res.body[0].hSessionId).toBe("sess");
    expect(res.body[0].agentViewUrl).toBe("u");
  });
});

describe("db migration", () => {
  it("adds new columns to an old-schema db without data loss", () => {
    const dir = mkdtempSync(join(tmpdir(), "mimk-"));
    const path = join(dir, "old.db");
    const raw = new Database(path);
    raw.exec(`CREATE TABLE subjects (id TEXT PRIMARY KEY, type TEXT, name TEXT, approvedSources TEXT, createdAt TEXT);
      CREATE TABLE runs (id TEXT PRIMARY KEY, subjectId TEXT, status TEXT, containerId TEXT, createdAt TEXT);
      INSERT INTO subjects VALUES ('s1','volunteer','Old','["w"]','t');
      INSERT INTO runs VALUES ('r1','s1','done',NULL,'t');`);
    raw.close();
    const db = createDb(path);
    const run: any = db.getRun("r1");
    expect(run.backend).toBe("docker");
    expect(run.hSessionId).toBeNull();
    expect(db.getSubject("s1")!.name).toBe("Old");
  });
});
