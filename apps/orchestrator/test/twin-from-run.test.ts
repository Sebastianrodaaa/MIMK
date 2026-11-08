import { describe, expect, it } from "vitest";
import request from "supertest";
import { createDb } from "../src/db.js";
import { createApp } from "../src/app.js";

const env = { MODEL_BASE_URL: "", MODEL_NAME: "m", MODEL_API_KEY: "" };

function seed() {
  const db = createDb(":memory:");
  const run = {
    id: "r1", subjectId: "_chat", task: "research founders",
    status: "done" as const, backend: "docker" as const,
    createdAt: new Date().toISOString(),
  };
  db.addRun(run);
  const ts = new Date().toISOString();
  db.addFinding({ runId: "r1", subjectId: "_chat", sourceUrl: "https://example.com/a", summary: "Fact one.", ts });
  db.addFinding({ runId: "r1", subjectId: "_chat", sourceUrl: "https://example.com/b", summary: "Fact two.", ts });
  return db;
}

describe("POST /runs/:id/twin", () => {
  it("creates subject, copies findings, builds dossier + twin", async () => {
    const db = seed();
    const app = createApp({ db, docker: {} as any, agentImage: "img", modelEnv: env });
    const res = await request(app).post("/runs/r1/twin").send({ name: "Ada Test", fixture: true });
    expect(res.status).toBe(200);
    expect(res.body.subjectId).toBeTruthy();
    expect(res.body.persona.name).toBe("Ada Test");
    const subject = db.listSubjects()[0];
    expect(subject.name).toBe("Ada Test");
    // findings copied under the new subject
    const copied = db.getFindings(subject.id);
    expect(copied.length).toBeGreaterThanOrEqual(2);
    // dossier + twin persisted
    const d = await request(app).get(`/subjects/${subject.id}/dossier`);
    expect(d.status).toBe(200);
    const twins = await request(app).get("/twins");
    expect(twins.body.some((t: any) => t.id === res.body.persona.id)).toBe(true);
  });

  it("reuses the existing subject case-insensitively", async () => {
    const db = seed();
    const app = createApp({ db, docker: {} as any, agentImage: "img", modelEnv: env });
    await request(app).post("/runs/r1/twin").send({ name: "Ada Test", fixture: true });
    const res2 = await request(app).post("/runs/r1/twin").send({ name: "ada test", fixture: true });
    expect(res2.status).toBe(200);
    expect(db.listSubjects()).toHaveLength(1);
  });

  it("400 missing name, 404 unknown run", async () => {
    const db = seed();
    const app = createApp({ db, docker: {} as any, agentImage: "img", modelEnv: env });
    expect((await request(app).post("/runs/r1/twin").send({})).status).toBe(400);
    expect((await request(app).post("/runs/nope/twin").send({ name: "X" })).status).toBe(404);
  });
});
