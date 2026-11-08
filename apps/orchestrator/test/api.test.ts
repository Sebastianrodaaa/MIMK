import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createDb } from "../src/db.js";

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
let db: ReturnType<typeof createDb>;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  db = createDb(":memory:");
  app = createApp({ db, docker, agentImage: "img", modelEnv: env });
  vi.clearAllMocks();
});

describe("POST /subjects", () => {
  it("rejects invalid type", async () => {
    const res = await request(app).post("/subjects").send({
      type: "random", name: "X", approvedSources: ["wiki"], consent: true,
    });
    expect(res.status).toBe(400);
  });
  it("rejects empty approvedSources", async () => {
    const res = await request(app).post("/subjects").send({
      type: "volunteer", name: "X", approvedSources: [], consent: true,
    });
    expect(res.status).toBe(400);
  });
  it("creates a valid subject", async () => {
    const res = await request(app).post("/subjects").send({
      type: "public_figure", name: "X", approvedSources: ["wikipedia"], consent: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
  });
});

describe("POST /runs", () => {
  it("spawns a labelled container", async () => {
    const sub = await request(app).post("/subjects").send({
      type: "volunteer", name: "X", approvedSources: ["wikipedia"], consent: true,
    });
    const res = await request(app).post("/runs").send({ subjectId: sub.body.id, count: 2 });
    expect(res.status).toBe(201);
    expect(res.body).toHaveLength(2);
    expect(docker.createContainer).toHaveBeenCalledTimes(2);
    const arg = docker.createContainer.mock.calls[0][0] as any;
    expect(arg.name).toMatch(/^mimk-agent-/);
    expect(arg.Labels["mimk.run"]).toBe(res.body[0].id);
  });
  it("rejects unknown subject", async () => {
    const res = await request(app).post("/runs").send({ subjectId: "nope" });
    expect(res.status).toBe(400);
  });
});

describe("consent + dossier", () => {
  it("rejects missing consent", async () => {
    const res = await request(app).post("/subjects").send({
      type: "volunteer", name: "X", approvedSources: ["w"],
    });
    expect(res.status).toBe(400);
  });
  it("builds a dossier from provided findings", async () => {
    const sub = await request(app).post("/subjects").send({
      type: "volunteer", name: "X", approvedSources: ["w"], consent: true,
    });
    const res = await request(app)
      .post(`/subjects/${sub.body.id}/dossier`)
      .send({ findings: [
        { runId: "r", subjectId: sub.body.id, sourceUrl: "https://a", summary: "fact one", ts: "t" },
        { runId: "r", subjectId: sub.body.id, sourceUrl: "https://a", summary: "fact one", ts: "t" },
      ]});
    expect(res.status).toBe(200);
    expect(res.body.facts).toHaveLength(1);
  });
  it("creates a fixture twin without chat", async () => {
    const sub = await request(app).post("/subjects").send({
      type: "volunteer", name: "Twin Tester", approvedSources: ["w"], consent: true,
    });
    const res = await request(app).post(`/subjects/${sub.body.id}/twin`).send({});
    expect(res.status).toBe(200);
    expect(res.body.id).toBeTruthy();
    const chat = await request(app)
      .post(`/twins/${res.body.id}/chat`).send({ message: "hello" });
    expect(chat.status).toBe(200);
    expect(chat.body.reply).toContain("Twin Tester");
  });
});
