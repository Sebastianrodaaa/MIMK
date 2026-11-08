import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { EventEmitter } from "node:events";
import { createDb } from "../src/db.js";
import { attachCollector } from "../src/collector.js";
import { createApp } from "../src/app.js";

function fakeLogStream(lines: string[]) {
  const e = new EventEmitter() as any;
  setImmediate(() => {
    for (const l of lines) e.emit("data", Buffer.from(l + "\n"));
  });
  return e;
}

const finding = (url: string, summary: string) =>
  JSON.stringify({ ts: "t", kind: "finding", data: { runId: "r1", sourceUrl: url, summary, ts: "t" } });

describe("attachCollector", () => {
  it("parses finding lines and dedupes", async () => {
    const db = createDb(":memory:");
    const lines = [
      finding("https://a", "fact one"),
      '{"ts":"t","kind":"log","data":{"msg":"noise"}}',
      "not json at all",
      finding("https://a", "fact one"),
      finding("https://b", "fact two"),
    ];
    const docker = {
      getContainer: () => ({ logs: async () => fakeLogStream(lines) }),
    } as any;
    await attachCollector({ id: "r1", subjectId: "s1", containerId: "c1" }, docker, db);
    await new Promise((r) => setTimeout(r, 50));
    const rows = db.getFindings("s1");
    expect(rows).toHaveLength(2);
    expect(rows.map((r: any) => r.sourceUrl).sort()).toEqual(["https://a", "https://b"]);
  });
});

describe("pipeline endpoint", () => {
  it("builds dossier + twin from persisted findings", async () => {
    const db = createDb(":memory:");
    const fakeContainer = {
      id: "c1", start: vi.fn(async () => {}), kill: vi.fn(), remove: vi.fn(),
      inspect: vi.fn(async () => ({ NetworkSettings: { Ports: {} } })),
    };
    const docker = {
      createContainer: vi.fn(async () => fakeContainer),
      getContainer: vi.fn(() => ({ logs: async () => fakeLogStream([finding("https://x", "persisted fact")]) })),
    } as any;
    const app = createApp({ db, docker, agentImage: "img", modelEnv: { MODEL_BASE_URL: "", MODEL_NAME: "m", MODEL_API_KEY: "" } });
    const sub = await request(app).post("/subjects").send({
      type: "volunteer", name: "Pipe Tester", approvedSources: ["w"], consent: true,
    });
    await request(app).post("/runs").send({ subjectId: sub.body.id, count: 1 });
    await new Promise((r) => setTimeout(r, 50));
    expect(db.getFindings(sub.body.id)).toHaveLength(1);
    const res = await request(app).post(`/subjects/${sub.body.id}/pipeline`).send({});
    expect(res.status).toBe(200);
    expect(res.body.dossier.facts[0].claim).toBe("persisted fact");
    expect(res.body.persona.name).toBe("Pipe Tester");
    const twins = await request(app).get("/twins");
    expect(twins.body.some((t: any) => t.name === "Pipe Tester")).toBe(true);
  });
});

const log = (data: any) => JSON.stringify({ ts: "t", kind: "log", data });

describe("run lifecycle from finished events", () => {
  const dockerWith = (lines: string[]) => ({
    getContainer: () => ({ logs: async () => fakeLogStream(lines) }),
  }) as any;

  it("finished ok:true -> done", async () => {
    const db = createDb(":memory:");
    db.addRun({ id: "f1", subjectId: "s", status: "running", backend: "docker", containerId: "fc1", createdAt: "t" });
    await attachCollector({ id: "f1", subjectId: "s", containerId: "fc1" }, dockerWith([log({ msg: "finished", ok: true })]), db);
    await new Promise((r) => setTimeout(r, 50));
    expect(db.getRun("f1")!.status).toBe("done");
  });
  it("finished ok:false -> failed", async () => {
    const db = createDb(":memory:");
    db.addRun({ id: "f2", subjectId: "s", status: "running", backend: "docker", containerId: "fc2", createdAt: "t" });
    await attachCollector({ id: "f2", subjectId: "s", containerId: "fc2" }, dockerWith([log({ msg: "finished", ok: false })]), db);
    await new Promise((r) => setTimeout(r, 50));
    expect(db.getRun("f2")!.status).toBe("failed");
  });
  it("stream end without finished -> failed", async () => {
    const db = createDb(":memory:");
    db.addRun({ id: "r3", subjectId: "s", status: "running", backend: "docker", containerId: "c3", createdAt: "t" });
    const stream = fakeLogStream([log({ msg: "agent starting" })]);
    const docker = { getContainer: () => ({ logs: async () => stream }) } as any;
    await attachCollector({ id: "r3", subjectId: "s", containerId: "c3" }, docker, db);
    stream.emit("end");
    await new Promise((r) => setTimeout(r, 20));
    expect(db.getRun("r3")!.status).toBe("failed");
  });
});

describe("reattachCollectors reconcile", () => {
  it("marks stale running docker runs and leaves h runs alone", async () => {
    const { reattachCollectors } = await import("../src/collector.js");
    const db = createDb(":memory:");
    db.addRun({ id: "stale0", subjectId: "s", status: "running", backend: "docker", containerId: "c0", createdAt: "t" });
    db.addRun({ id: "stale1", subjectId: "s", status: "running", backend: "docker", containerId: "c1", createdAt: "t" });
    db.addRun({ id: "h1", subjectId: "s", status: "running", backend: "h", hSessionId: "x", createdAt: "t" });
    const docker = {
      listContainers: async () => [],
      getContainer: (id: string) => ({
        inspect: async () =>
          id === "c0" ? { State: { Running: false, ExitCode: 0 } } : { State: { Running: false, ExitCode: 1 } },
      }),
    } as any;
    await reattachCollectors(docker, db);
    expect(db.getRun("stale0")!.status).toBe("done");
    expect(db.getRun("stale1")!.status).toBe("failed");
    expect(db.getRun("h1")!.status).toBe("running");
  });
});
