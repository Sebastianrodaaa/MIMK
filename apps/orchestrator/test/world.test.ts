import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createBus } from "../src/bus.js";
import {
  extractWorldActions, heuristicWorldAction, parseMention,
} from "../src/world.js";
import { createDb } from "../src/db.js";
import { createApp } from "../src/app.js";
import { MirofishBackend } from "../src/sim.js";

const env = { MODEL_BASE_URL: "", MODEL_NAME: "m", MODEL_API_KEY: "" };

const twin = (id: string, name: string): any => ({
  id, subjectId: "s", name, traits: ["curious"], stances: [], speechStyle: "casual",
  interests: ["tech"], relationships: [], avatar: { palette: ["#000000", "#ffffff"], accessory: "none" },
  bio: `${name} bio`,
});

function appWith(deps: any = {}) {
  return createApp({
    db: createDb(":memory:"), docker: {} as any, agentImage: "img",
    modelEnv: env, worldDelayMs: 0, ...deps,
  });
}

describe("bus", () => {
  const nameOf = (id: string) => `name-${id}`;
  it("increments ids and publishes to subscribers", () => {
    const bus = createBus();
    const got: number[] = [];
    bus.subscribe((e) => got.push(e.id));
    bus.publish({ personaId: "a", kind: "post", text: "x" }, nameOf);
    bus.publish({ personaId: "b", kind: "reply", text: "y" }, nameOf);
    expect(got).toEqual([1, 2]);
  });
  it("trims the ring buffer to limit", () => {
    const bus = createBus(3);
    for (let i = 0; i < 5; i++) bus.publish({ personaId: "a", kind: "post", text: `t${i}` }, nameOf);
    const sub = bus.subscribe(() => {});
    expect(sub.history.map((e) => e.text)).toEqual(["t2", "t3", "t4"]);
    expect(sub.history[0].id).toBe(3);
  });
  it("returns history then live events, close stops delivery", () => {
    const bus = createBus();
    bus.publish({ personaId: "a", kind: "post", text: "old" }, nameOf);
    const got: string[] = [];
    const sub = bus.subscribe((e) => got.push(e.text));
    expect(sub.history.map((e) => e.text)).toEqual(["old"]);
    bus.publish({ personaId: "a", kind: "post", text: "new" }, nameOf);
    sub.close();
    bus.publish({ personaId: "a", kind: "post", text: "late" }, nameOf);
    expect(got).toEqual(["new"]);
  });
});

describe("extractWorldActions", () => {
  it("strips blocks and parses multiple actions", () => {
    const { reply, actions } = extractWorldActions(
      'Ok.<world_action>{"type":"inject","text":"pizza"}</world_action>' +
      '<world_action>{"type":"scenario","text":"wifi down","rounds":9}</world_action>'
    );
    expect(reply).toBe("Ok.");
    expect(actions).toEqual([
      { type: "inject", text: "pizza" },
      { type: "scenario", text: "wifi down", rounds: 3 },
    ]);
  });
  it("drops invalid JSON, unknown types and empty text", () => {
    const { actions } = extractWorldActions(
      '<world_action>{bad</world_action>' +
      '<world_action>{"type":"nuke","text":"x"}</world_action>' +
      '<world_action>{"type":"inject","text":" "}</world_action>'
    );
    expect(actions).toEqual([]);
  });
  it("caps at 3 actions and clamps simulate rounds to 1..20", () => {
    const block = (t: string) => `<world_action>{"type":"inject","text":"${t}"}</world_action>`;
    const { actions } = extractWorldActions(block("a") + block("b") + block("c") + block("d"));
    expect(actions).toHaveLength(3);
    const s = extractWorldActions('<world_action>{"type":"simulate","rounds":99}</world_action>');
    expect(s.actions[0]).toMatchObject({ type: "simulate", rounds: 20 });
  });
});

describe("heuristicWorldAction", () => {
  it("what if -> scenario, run the simulation -> simulate, else inject", () => {
    expect(heuristicWorldAction("What if it rains?")).toMatchObject({ type: "scenario" });
    expect(heuristicWorldAction("run the simulation")).toMatchObject({ type: "simulate" });
    expect(heuristicWorldAction("free pizza")).toEqual({ type: "inject", text: "free pizza" });
  });
});

describe("parseMention", () => {
  it("matches longest name first, case-insensitive", () => {
    const names = ["Ada", "Ada Voss"];
    expect(parseMention("@ada voss hi there", names)).toEqual({ persona: "Ada Voss", text: "hi there" });
    expect(parseMention("hello", names)).toBeUndefined();
    expect(parseMention("@nobody hi", names)).toBeUndefined();
  });
});

describe("POST /world/chat", () => {
  const seedTwins = (db: ReturnType<typeof createDb>) => {
    db.saveTwin(twin("t1", "Ada Voss"));
    db.saveTwin(twin("t2", "Marco Lenz"));
  };

  it("executes an inject block and feeds the bus", async () => {
    const db = createDb(":memory:");
    seedTwins(db);
    const chat = vi.fn(async () =>
      'Done.<world_action>{"type":"inject","text":"free pizza"}</world_action>');
    const app = appWith({ db, chat });
    const server = app.listen(0);
    const port = (server.address() as any).port;
    try {
      const res = await request(app).post("/world/chat")
        .send({ messages: [{ role: "user", content: "announce pizza" }] });
      expect(res.status).toBe(200);
      expect(res.body.reply).toBe("Done.");
      expect(res.body.actions).toHaveLength(1);

      const feed = await fetch(`http://localhost:${port}/world/feed`);
      const reader = feed.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      const events: any[] = [];
      await vi.waitFor(async () => {
        const { value } = await reader.read();
        if (value) {
          buf += dec.decode(value);
          for (const line of buf.split("\n\n")) {
            const m = line.match(/^data: (.*)$/s);
            if (m) { try { events.push(JSON.parse(m[1])); } catch {} }
          }
        }
        expect(events.some((e) => e.personaId === "_god" && e.text === "free pizza")).toBe(true);
        expect(events.filter((e) => e.kind === "reply").length).toBeGreaterThanOrEqual(1);
      }, { timeout: 5000 });
    } finally {
      server.close();
    }
  });

  it("falls back to heuristic inject when chat throws", async () => {
    const db = createDb(":memory:");
    const chat = vi.fn(async () => { throw new Error("boom"); });
    const res = await request(appWith({ db, chat })).post("/world/chat")
      .send({ messages: [{ role: "user", content: "the sky is green" }] });
    expect(res.status).toBe(200);
    expect(res.body.actions).toEqual([{ type: "inject", text: "the sky is green" }]);
  });

  it("@mention asks the twin in character", async () => {
    const db = createDb(":memory:");
    seedTwins(db);
    const chat = vi.fn(async (..._args: any[]) => "I love it!");
    const app = appWith({ db, chat });
    const res = await request(app).post("/world/chat")
      .send({ messages: [{ role: "user", content: "@Ada Voss what do you think?" }] });
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe("Asking Ada Voss…");
    expect(res.body.actions).toEqual([{ type: "ask", persona: "Ada Voss", text: "what do you think?" }]);
    await vi.waitFor(() => expect(chat).toHaveBeenCalledOnce());
    expect(chat.mock.calls[0]![0][0].content).toContain("Ada Voss");
  });

  it("400s without a user message", async () => {
    const res = await request(appWith({})).post("/world/chat").send({ messages: [] });
    expect(res.status).toBe(400);
  });
});

describe("GET /world/feed", () => {
  it("sends history flagged then live events", async () => {
    const db = createDb(":memory:");
    const app = appWith({ db });
    const server = app.listen(0);
    const port = (server.address() as any).port;
    try {
      // publish one event before connecting via a first feed? use /world/chat inject instead
      await request(app).post("/world/chat")
        .send({ messages: [{ role: "user", content: "seed event" }] });
      await new Promise((r) => setTimeout(r, 50));
      const res = await fetch(`http://localhost:${port}/world/feed`);
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      const readEvents = async (n: number) => {
        const out: any[] = [];
        let buf = "";
        while (out.length < n) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value);
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const p of parts) {
            const m = p.match(/^data: (.*)$/s);
            if (m) { try { out.push(JSON.parse(m[1])); } catch {} }
          }
        }
        return out;
      };
      const hist = await readEvents(2);
      expect(hist[0].history).toBe(true);
      expect(hist[0].personaId).toBe("_god");
      // live event after connect
      await request(app).post("/world/chat")
        .send({ messages: [{ role: "user", content: "second event" }] });
      const live = (await readEvents(1))[0];
      expect(live.history).toBeUndefined();
      expect(live.text).toBe("second event");
      reader.cancel();
    } finally {
      server.close();
    }
  });
});

describe("sim start", () => {
  it("passes scenario through to the backend", async () => {
    const start = vi.fn(async () => "started");
    const sim = { seedDocument: () => "", events: async function* () {}, start };
    const db = createDb(":memory:");
    db.saveTwin(twin("t1", "Ada"));
    const res = await request(appWith({ db, simBackend: sim })).post("/sim/start")
      .send({ scenario: "wifi down", maxRounds: 3 });
    expect(res.status).toBe(200);
    expect(start).toHaveBeenCalledWith([expect.objectContaining({ name: "Ada" })], 3, "wifi down");
  });
});

describe("MirofishBackend running reset", () => {
  it("allows a second start after the first finishes", async () => {
    class TestBackend extends MirofishBackend {
      override async start(personas: any[], rounds: number): Promise<string> {
        (this as any).drive = async () => {};
        return super.start(personas, rounds);
      }
    }
    const b = new TestBackend("http://x", (async () => ({ ok: true, json: async () => ({}) })) as any);
    expect(await b.start([{ id: "p", name: "P" } as any], 1)).toBe("started");
    await new Promise((r) => setTimeout(r, 20));
    expect(await b.start([{ id: "p", name: "P" } as any], 1)).toBe("started");
  });
});

describe("twin removal", () => {
  const seedTwins = (db: ReturnType<typeof createDb>) => {
    db.saveTwin(twin("t1", "Ada Voss"));
    db.saveTwin(twin("t2", "Marco Lenz"));
  };

  it("deleteTwin tombstones; seedTwin skips; saveTwin resurrects", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const path = join(mkdtempSync(join(tmpdir(), "mimk-")), "t.db");
    let db = createDb(path);
    db.saveTwin(twin("t1", "Ada"));
    expect(db.deleteTwin("t1")).toBe(true);
    expect(db.deleteTwin("t1")).toBe(false);
    expect(db.getTwin("t1")).toBeUndefined();
    expect(db.isTwinDeleted("t1")).toBe(true);
    db.seedTwin(twin("t1", "Ada")); // tombstoned -> skipped
    expect(db.getTwin("t1")).toBeUndefined();
    db.seedTwin(twin("t3", "New"));
    expect(db.getTwin("t3")!.name).toBe("New");
    db.saveTwin(twin("t1", "Ada")); // explicit save resurrects
    expect(db.getTwin("t1")).toBeDefined();
    expect(db.isTwinDeleted("t1")).toBe(false);
    db.saveTwin(twin("t4", "Four"));
    expect(db.deleteAllTwins()).toBe(3);
    expect(db.listTwins()).toHaveLength(0);
    db = createDb(path); // reopen: tombstones persist
    expect(db.isTwinDeleted("t1")).toBe(true);
  });

  it("DELETE /twins/:id removes and publishes, 404s the second time", async () => {
    const db = createDb(":memory:");
    seedTwins(db);
    const app = appWith({ db });
    const server = app.listen(0);
    const port = (server.address() as any).port;
    try {
      const res = await request(app).delete("/twins/t1");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect((await request(app).delete("/twins/t1")).status).toBe(404);
      expect(db.listTwins().map((t) => t.name)).toEqual(["Marco Lenz"]);
      // bus has the left-the-world post
      const feed = await fetch(`http://localhost:${port}/world/feed`);
      const { value } = await feed.body!.getReader().read();
      expect(new TextDecoder().decode(value)).toContain("Ada Voss left the world.");
    } finally {
      server.close();
    }
  });

  it("DELETE /twins returns count", async () => {
    const db = createDb(":memory:");
    seedTwins(db);
    const res = await request(appWith({ db })).delete("/twins");
    expect(res.body.removed).toBe(2);
    expect(db.listTwins()).toHaveLength(0);
  });

  it("world chat remove action removes the twin; unknown name posts notice", async () => {
    const db = createDb(":memory:");
    seedTwins(db);
    const chat = vi.fn(async () =>
      'Gone.<world_action>{"type":"remove","persona":"ada voss"}</world_action><world_action>{"type":"remove","persona":"Nobody"}</world_action>');
    const res = await request(appWith({ db, chat })).post("/world/chat")
      .send({ messages: [{ role: "user", content: "remove Ada" }] });
    expect(res.body.actions).toHaveLength(2);
    await vi.waitFor(() => expect(db.getTwin("t1")).toBeUndefined());
    expect(db.getTwin("t2")).toBeDefined();
  });

  it("heuristic remove works with no LLM", async () => {
    const db = createDb(":memory:");
    seedTwins(db);
    const res = await request(appWith({ db })).post("/world/chat")
      .send({ messages: [{ role: "user", content: "remove Ada Voss" }] });
    expect(res.body.actions).toEqual([{ type: "remove", persona: "Ada Voss" }]);
    await vi.waitFor(() => expect(db.getTwin("t1")).toBeUndefined());
  });

  it("extractWorldActions validates remove", async () => {
    const { actions } = extractWorldActions(
      '<world_action>{"type":"remove","persona":"Ada"}</world_action><world_action>{"type":"remove","persona":" "}</world_action>');
    expect(actions).toEqual([{ type: "remove", persona: "Ada" }]);
  });
});
