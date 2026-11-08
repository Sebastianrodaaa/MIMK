import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import request from "supertest";
import { createDb } from "../src/db.js";
import { createApp } from "../src/app.js";
import { extractSpawn, heuristicSpawn } from "../src/chat.js";

const env = { MODEL_BASE_URL: "", MODEL_NAME: "m", MODEL_API_KEY: "" };

function mockHClient() {
  return {
    createSession: vi.fn(async () => ({ id: "sess", agent_view_url: "u" })),
    createTaskSession: vi.fn(async () => ({ id: "tsess", agent_view_url: "u" })),
    getChanges: vi.fn(async () => ({ status: "running", new_events: [], first_index: 0 })),
    cancelSession: vi.fn(async () => null),
  } as any;
}

function appWith(deps: any = {}) {
  return createApp({ db: createDb(":memory:"), docker: {} as any, agentImage: "img", modelEnv: env, ...deps });
}

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

describe("extractSpawn", () => {
  it("strips the block and parses tasks", () => {
    const { reply, tasks } = extractSpawn(
      'On it.<spawn_agents>{"tasks":["task one","task two"]}</spawn_agents>'
    );
    expect(reply).toBe("On it.");
    expect(tasks).toEqual(["task one", "task two"]);
  });
  it("ignores malformed JSON", () => {
    const { reply, tasks } = extractSpawn("hi<spawn_agents>{oops</spawn_agents>");
    expect(reply).toBe("hi");
    expect(tasks).toEqual([]);
  });
  it("caps at 4 tasks", () => {
    const many = Array.from({ length: 12 }, (_, i) => `t${i}`);
    const { tasks } = extractSpawn(`<spawn_agents>${JSON.stringify({ tasks: many })}</spawn_agents>`);
    expect(tasks).toHaveLength(4);
  });
  it("parses a mixed array of strings and person objects", () => {
    const { tasks } = extractSpawn(
      `<spawn_agents>${JSON.stringify({
        tasks: ["open example.com", { task: "focus on career", person: "Ada Lovelace" }],
      })}</spawn_agents>`
    );
    expect(tasks).toEqual(["open example.com", { task: "focus on career", person: "Ada Lovelace" }]);
  });
  it("drops objects with an empty person", () => {
    const { tasks } = extractSpawn(
      `<spawn_agents>{"tasks":[{"task":"x","person":"  "},{"person":"Grace Hopper"}]}</spawn_agents>`
    );
    expect(tasks).toEqual([{ task: "", person: "Grace Hopper" }]);
  });
});

describe("POST /agents", () => {
  it("400s on empty tasks", async () => {
    const res = await request(appWith({ agentBackend: "h", hClient: mockHClient() })).post("/agents").send({ tasks: [] });
    expect(res.status).toBe(400);
  });
  it("201s and creates runs with task and subjectId _chat", async () => {
    const hClient = mockHClient();
    const res = await request(appWith({ agentBackend: "h", hClient })).post("/agents").send({ tasks: ["open example.com"] });
    expect(res.status).toBe(201);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].task).toBe("open example.com");
    expect(res.body[0].subjectId).toBe("_chat");
    expect(res.body[0].hSessionId).toBe("tsess");
    expect(hClient.createTaskSession).toHaveBeenCalledOnce();
  });
  it("429s when at capacity", async () => {
    const db = createDb(":memory:");
    db.addRun({ id: "r1", subjectId: "s", status: "running", backend: "h", createdAt: "t" });
    const res = await request(appWith({ db, agentBackend: "h", hClient: mockHClient(), maxParallel: 1 }))
      .post("/agents").send({ tasks: ["x"] });
    expect(res.status).toBe(429);
  });
  it("creates and reuses a Subject for object tasks", async () => {
    const db = createDb(":memory:");
    const hClient = mockHClient();
    const app = appWith({ db, agentBackend: "h", hClient });
    const res = await request(app).post("/agents")
      .send({ tasks: [{ task: "focus on career", person: "Linus Torvalds" }] });
    expect(res.status).toBe(201);
    const subject = db.listSubjects()[0];
    expect(subject.name).toBe("Linus Torvalds");
    const body0 = (res.body.runs ?? res.body)[0];
    expect(body0.subjectId).toBe(subject.id);
    expect(body0.task).toBe("OSINT: Linus Torvalds — focus on career");
    expect(hClient.createSession).toHaveBeenCalledOnce();
    const prompt = hClient.createSession.mock.calls[0][1] as string;
    expect(prompt).toContain("Linus Torvalds");
    expect(prompt).toContain("focus on career");
    expect(hClient.createTaskSession).not.toHaveBeenCalled();

    const res2 = await request(app).post("/agents")
      .send({ tasks: [{ task: "", person: "linus torvalds" }] });
    expect(res2.status).toBe(201);
    expect(db.listSubjects()).toHaveLength(1);
    expect((res2.body.runs ?? res2.body)[0].subjectId).toBe(subject.id);
    expect((res2.body.runs ?? res2.body)[0].task).toBe("OSINT: linus torvalds");
  });
  it("still uses createTaskSession for string tasks", async () => {
    const hClient = mockHClient();
    const res = await request(appWith({ agentBackend: "h", hClient })).post("/agents").send({ tasks: ["do a thing"] });
    expect(res.status).toBe(201);
    expect(res.body[0].subjectId).toBe("_chat");
    expect(hClient.createTaskSession).toHaveBeenCalledOnce();
    expect(hClient.createSession).not.toHaveBeenCalled();
  });
});

describe("POST /chat", () => {
  it("spawns agents when the model emits a spawn block", async () => {
    const chat = vi.fn(async () =>
      'Spinning up agents.<spawn_agents>{"tasks":["a","b"]}</spawn_agents>');
    const res = await request(appWith({ chat, agentBackend: "h", hClient: mockHClient() }))
      .post("/chat").send({ messages: [{ role: "user", content: "spawn 2 agents" }] });
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe("Spinning up agents.");
    expect(res.body.runs).toHaveLength(2);
  });
  it("returns runs: [] for plain text", async () => {
    const chat = vi.fn(async () => "Just chatting.");
    const res = await request(appWith({ chat, agentBackend: "h", hClient: mockHClient() }))
      .post("/chat").send({ messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reply: "Just chatting.", runs: [] });
  });
  it("400s without a user message", async () => {
    const res = await request(appWith({})).post("/chat").send({ messages: [] });
    expect(res.status).toBe(400);
  });
  it("uses the heuristic when chat is unavailable", async () => {
    const res = await request(appWith({ agentBackend: "h", hClient: mockHClient() }))
      .post("/chat").send({ messages: [{ role: "user", content: "open example.com" }] });
    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(1);
    const plain = await request(appWith({}))
      .post("/chat").send({ messages: [{ role: "user", content: "hello there" }] });
    expect(plain.body.reply).toContain("offline");
    expect(plain.body.runs).toEqual([]);
  });
});

describe("heuristicSpawn", () => {
  it("spawns N agents for 'N agents'", () => {
    expect(heuristicSpawn("spawn 3 agents to search for cats").tasks).toHaveLength(3);
    expect(heuristicSpawn("hello").tasks).toHaveLength(0);
  });
  it("treats research phrases as OSINT tasks", () => {
    const { tasks } = heuristicSpawn("research Linus Torvalds with 2 agents");
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toEqual({ task: "", person: "Linus Torvalds" });
  });
});

describe("docker agent backend", () => {
  function fakeDocker() {
    const container = {
      id: "cid",
      start: vi.fn(async () => {}),
      inspect: vi.fn(async () => ({
        NetworkSettings: { Ports: { "6080/tcp": [{ HostIp: "127.0.0.1", HostPort: "51234" }] } },
      })),
    };
    const docker = {
      createContainer: vi.fn(async () => container),
      getContainer: vi.fn(() => ({
        logs: async () => new EventEmitter() as any,
      })),
    } as any;
    return { docker, container };
  }

  it("spawns a docker desktop for a string task", async () => {
    const { docker } = fakeDocker();
    const hClient = mockHClient();
    const res = await request(appWith({ docker, hClient })).post("/agents").send({ tasks: ["open example.com"] });
    expect(res.status).toBe(201);
    const cfg = docker.createContainer.mock.calls[0]![0] as any;
    expect(cfg.Env).toContain("TASK=open example.com");
    expect(cfg.Env.some((e: string) => e.startsWith("SUBJECT_JSON"))).toBe(false);
    expect(cfg.HostConfig.PortBindings["6080/tcp"][0].HostIp).toBe("127.0.0.1");
    expect(res.body[0].backend).toBe("docker");
    expect(res.body[0].vncPort).toBe(51234);
    expect(res.body[0].subjectId).toBe("_chat");
    expect(hClient.createTaskSession).not.toHaveBeenCalled();
  });

  it("spawns a docker OSINT run with SUBJECT_JSON + TASK_EXTRA", async () => {
    const { docker } = fakeDocker();
    const db = createDb(":memory:");
    const res = await request(appWith({ db, docker })).post("/agents")
      .send({ tasks: [{ task: "focus on career", person: "Linus Torvalds" }] });
    expect(res.status).toBe(201);
    const cfg = docker.createContainer.mock.calls[0]![0] as any;
    const subj = cfg.Env.find((e: string) => e.startsWith("SUBJECT_JSON="));
    expect(JSON.parse(subj.slice(13)).name).toBe("Linus Torvalds");
    expect(cfg.Env).toContain("TASK_EXTRA=focus on career");
    const subject = db.listSubjects()[0]!;
    const body0 = (res.body.runs ?? res.body)[0];
    expect(body0.subjectId).toBe(subject.id);
    expect(body0.task).toBe("OSINT: Linus Torvalds — focus on career");

    await request(appWith({ db, docker: fakeDocker().docker })).post("/agents")
      .send({ tasks: [{ task: "", person: "linus torvalds" }] });
    expect(db.listSubjects()).toHaveLength(1);
  });

  it("400s on 5 tasks", async () => {
    const res = await request(appWith({ docker: fakeDocker().docker }))
      .post("/agents").send({ tasks: ["a", "b", "c", "d", "e"] });
    expect(res.status).toBe(400);
  });
});

describe("osint pre-pass", () => {
  const stubLeads = {
    searchPerson: vi.fn(async () => ({
      name: "Ada Voss",
      facts: [{ summary: "Ada is a fictional security researcher.", sourceUrl: "https://en.wikipedia.org/wiki/Ada", source: "wikipedia" }],
      handles: { github: "adavoss" },
      ms: 800,
      timings: [],
    })),
  };

  it("persists leads as prepass findings, LEADS_JSON in docker env, instant in response", async () => {
    const db = createDb(":memory:");
    const docker = fakeDocker().docker;
    const res = await request(appWith({ db, docker, osint: stubLeads })).post("/agents")
      .send({ tasks: [{ person: "Ada Voss", task: "bio" }] });
    expect(res.status).toBe(201);
    const leads = res.body.instant?.[0];
    expect(leads?.person).toBe("Ada Voss");
    expect(leads?.handles.github).toBe("adavoss");
    const subject = db.listSubjects()[0]!;
    const env: string[] = ((docker.createContainer.mock.calls[0] as any)![0] as any).Env;
    const lj = env.find((e) => e.startsWith("LEADS_JSON="));
    expect(lj).toBeDefined();
    expect(lj).toContain("adavoss");
    const findings = db.getFindings(subject.id);
    expect(findings.some((f) => f.runId === `prepass:${subject.id}` && f.summary.includes("security researcher"))).toBe(true);
  });

  it("h backend gets leads appended to task text", async () => {
    const db = createDb(":memory:");
    const hClient = mockHClient();
    await request(appWith({ db, hClient, agentBackend: "h", osint: stubLeads })).post("/agents")
      .send({ tasks: [{ person: "Ada Voss", task: "bio" }] });
    const prompt = hClient.createSession.mock.calls[0]![1] as string;
    expect(prompt).toContain("Known leads");
    expect(prompt).toContain("adavoss");
  });

  it("spawn still succeeds when searchPerson rejects", async () => {
    const db = createDb(":memory:");
    const docker = fakeDocker().docker;
    const res = await request(appWith({ db, docker, osint: { searchPerson: vi.fn(async () => { throw new Error("net down"); }) } }))
      .post("/agents").send({ tasks: [{ person: "Ada Voss", task: "bio" }] });
    expect(res.status).toBe(201);
    expect(res.body.instant).toBeUndefined();
  });

  it("/chat returns instant for person task, none for string task", async () => {
    const db = createDb(":memory:");
    const docker = fakeDocker().docker;
    const chat = vi.fn(async () => 'ok<spawn_agents>{"tasks":[{"person":"Ada Voss","task":"bio"}]}</spawn_agents>');
    const res = await request(appWith({ db, docker, chat, osint: stubLeads })).post("/chat")
      .send({ messages: [{ role: "user", content: "research Ada Voss" }] });
    expect(res.body.instant?.[0]?.person).toBe("Ada Voss");
    const chat2 = vi.fn(async () => 'ok<spawn_agents>{"tasks":["open example.com"]}</spawn_agents>');
    const res2 = await request(appWith({ db, docker, chat: chat2 })).post("/chat")
      .send({ messages: [{ role: "user", content: "do a task" }] });
    expect(res2.body.instant).toBeUndefined();
  });
});

describe("deterministic spawn fallback", () => {
  it("spawns person tasks when model answers conversationally", async () => {
    const db = createDb(":memory:");
    const docker = fakeDocker().docker;
    const chat = vi.fn(async () => "I'll help you research Linus Torvalds.");
    const res = await request(appWith({ db, docker, chat })).post("/chat")
      .send({ messages: [{ role: "user", content: "research Linus Torvalds using 2 agents" }] });
    expect(res.body.runs).toHaveLength(2);
    expect(res.body.runs[0].subjectId).not.toBe("_chat");
  });
  it("look up spawns one person task", async () => {
    const db = createDb(":memory:");
    const docker = fakeDocker().docker;
    const chat = vi.fn(async () => "Sure, let me look that up.");
    const res = await request(appWith({ db, docker, chat })).post("/chat")
      .send({ messages: [{ role: "user", content: "look up Ada Lovelace" }] });
    expect(res.body.runs).toHaveLength(1);
  });
  it("does not spawn on ordinary conversation", async () => {
    const db = createDb(":memory:");
    const chat = vi.fn(async () => "Research can be fun!");
    for (const msg of ["research is fun", "can you explain agents?"]) {
      const res = await request(appWith({ db, chat })).post("/chat")
        .send({ messages: [{ role: "user", content: msg }] });
      expect(res.body.runs).toEqual([]);
    }
  });
  it("valid spawn block wins over heuristic", async () => {
    const db = createDb(":memory:");
    const docker = fakeDocker().docker;
    const chat = vi.fn(async () => 'ok<spawn_agents>{"tasks":["open x.com"]}</spawn_agents>');
    const res = await request(appWith({ db, docker, chat })).post("/chat")
      .send({ messages: [{ role: "user", content: "research Linus Torvalds using 2 agents" }] });
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.runs[0].subjectId).toBe("_chat");
  });
});
