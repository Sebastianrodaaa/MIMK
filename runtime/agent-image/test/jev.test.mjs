// Offline unit tests for jev.ts — compiles sources into a temp dir.
import { mkdtempSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import http from "node:http";
import assert from "node:assert";

const tmp = mkdtempSync(join(tmpdir(), "jev-build-"));
cpSync("lane", join(tmp, "lane"), { recursive: true });
execFileSync("npx", ["tsc",
   "jev.ts", "--target", "es2022", "--module", "nodenext", "--moduleResolution", "nodenext",
   "--strict", "--skipLibCheck", "--types", "node", "--outDir", tmp],
  { cwd: new URL("..", import.meta.url).pathname, stdio: "inherit" });
const { jevChoose, buildCandidates, runJevResearch } = await import(join(tmp, "jev.js"));

const okPayload = (choice = "fetch_1", conf = 0.9) =>
  JSON.stringify({ model: "jev", answers: { action: { type: "choice", choice, confidence: conf, probabilities: { [choice]: conf } } } });

function mockJev(handler) {
  const bodies = [];
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { bodies.push({ headers: req.headers, body: b }); handler(req, res); });
  });
  return { srv, bodies };
}

// 1. valid call — request shape exact
{
  const { srv, bodies } = mockJev((req, res) => res.end(okPayload("fetch_1", 0.87)));
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;
  const r = await jevChoose({
    apiKey: "sk-test", endpoint: `http://127.0.0.1:${port}/decisions`, key: "action",
    task: "pick", rules: ["r1"], state: { subject: "X" }, criteria: { fetch_1: "fetch a", finish: "stop" },
  });
  assert.equal(r.choice, "fetch_1");
  assert.equal(r.confidence, 0.87);
  const sent = JSON.parse(bodies[0].body);
  assert.equal(sent.model, "~typesafe/jev-latest");
  assert.equal(sent.state.subject, "X");
  assert.equal(sent.questions.action.type, "choice");
  assert.equal(sent.questions.action.instructions.task, "pick");
  assert.deepEqual(sent.questions.action.instructions.rules, ["r1"]);
  assert.ok(sent.questions.action.criteria.fetch_1);
  assert.equal(bodies[0].headers["x-title"], "mimk");
  srv.close();
}

// 2. invalid choice id
{
  const { srv } = mockJev((req, res) => res.end(okPayload("bogus")));
  await new Promise((r) => srv.listen(0, r));
  await assert.rejects(jevChoose({ apiKey: "k", endpoint: `http://127.0.0.1:${srv.address().port}`, task: "t", rules: [], state: {}, criteria: { a: "x" } }), /invalid decision/);
  srv.close();
}
// 3. confidence out of range
{
  const { srv } = mockJev((req, res) => res.end(okPayload("a", 1.5)));
  await new Promise((r) => srv.listen(0, r));
  await assert.rejects(jevChoose({ apiKey: "k", endpoint: `http://127.0.0.1:${srv.address().port}`, task: "t", rules: [], state: {}, criteria: { a: "x" } }), /invalid/);
  srv.close();
}
// 4. non-2xx — error must not contain the api key
{
  const { srv } = mockJev((req, res) => { res.statusCode = 401; res.end(JSON.stringify({ error: { message: "bad key" } })); });
  await new Promise((r) => srv.listen(0, r));
  const e = await jevChoose({ apiKey: "sk-secret-123", endpoint: `http://127.0.0.1:${srv.address().port}`, task: "t", rules: [], state: {}, criteria: { a: "x" } }).catch((e) => e);
  assert.match(e.message, /HTTP 401/);
  assert.ok(!e.message.includes("sk-secret-123"));
  srv.close();
}
// 5. malformed JSON
{
  const { srv } = mockJev((req, res) => res.end("not json{"));
  await new Promise((r) => srv.listen(0, r));
  await assert.rejects(jevChoose({ apiKey: "k", endpoint: `http://127.0.0.1:${srv.address().port}`, task: "t", rules: [], state: {}, criteria: { a: "x" } }), /invalid JSON/);
  srv.close();
}

// 6. candidate builder
{
  const cs = buildCandidates({
    subject: "Linus Torvalds",
    facts: [
      { summary: "bio", sourceUrl: "https://en.wikipedia.org/wiki/Linus_Torvalds", source: "wikipedia" },
      { summary: "work", sourceUrl: "https://www.wikidata.org/wiki/Q34253", source: "wikidata" },
      { summary: "leak", sourceUrl: "https://www.linkedin.com/in/x", source: "web" },
      { summary: "db", sourceUrl: "https://beenverified.com/x", source: "web" },
    ],
    handles: { github: "torvalds" },
    visited: new Set(["https://en.wikipedia.org/wiki/Linus_Torvalds"]),
    fetched: new Map(),
    usernameDone: false,
    evidence: [],
  });
  assert.ok(cs.some((c) => c.id === "finish"));
  assert.ok(!cs.some((c) => c.url === "https://en.wikipedia.org/wiki/Linus_Torvalds"), "visited included");
  assert.ok(!cs.some((c) => /linkedin|beenverified/.test(c.url ?? "")), "blocked domain included");
  assert.ok(cs.some((c) => c.kind === "username" && c.handle === "torvalds"));
  assert.ok(cs.length <= 10);
  const again = buildCandidates({ subject: "Linus Torvalds", facts: [], handles: {}, visited: new Set(), fetched: new Map(), usernameDone: true, evidence: [] });
  assert.deepEqual(again.map((c) => c.id), ["finish"], "no facts → only finish");
}

// 7. runner: step-0 first, gui mirror, finish ends, synthesize once, findings
{
  const order = [];
  let jevCalls = 0, guiOpens = [];
  const ctx = {
    emit: () => {}, subject: "Ada Test", goal: "bio",
    leads: { name: "Ada Test", facts: [{ summary: "Ada is X.", sourceUrl: "https://en.wikipedia.org/wiki/Ada", source: "wikipedia" }], handles: { github: "ada" } },
    searchPerson: async () => { order.push("search"); return { facts: [], handles: {} }; },
    fetchText: async (urls) => {
      order.push("fetchText:" + urls.length);
      return urls.map((u) => ({ url: u, ok: true, status: 200, title: u, text: `text about ${u}`.repeat(50), ms: 5 }));
    },
    usernameLane: async () => "verified: https://github.com/ada",
    launchGui: async (url) => { guiOpens.push(url); },
    readGui: async () => "A11Y SNAPSHOT:\npagetext",
    synthesize: async () => { order.push("synth"); return { summary: "done.", findings: [{ sourceUrl: "https://en.wikipedia.org/wiki/Ada", summary: "Ada is X." }] }; },
    jevChoose: async (o) => {
      jevCalls++;
      order.push("jev");
      return { choice: "finish", confidence: 0.95, elapsedMs: 10 };
    },
    apiKey: "k",
  };
  const r = await runJevResearch(ctx);
  assert.ok(order[0].startsWith("fetchText:"), `step-0 fetch first: ${order}`);
  assert.equal(order.indexOf("synth"), order.length - 1, "synth last");
  assert.ok(guiOpens.includes("https://en.wikipedia.org/wiki/Ada"), "gui mirror");
  assert.equal(r.findings.length, 1);
  assert.equal(jevCalls, 1);
}

// 8. runner: 3 consecutive jev failures → throws (caller falls back)
{
  let n = 0;
  const ctx = {
    emit: () => {}, subject: "X", goal: "g",
    leads: null,
    searchPerson: async () => ({ facts: [1,2,3,4].map((i)=>({ summary: `s${i}`, sourceUrl: `https://example.com/${i}`, source: "x" })), handles: {} }),
    fetchText: async (urls) => urls.map((u) => ({ url: u, ok: true, status: 200, text: "t".repeat(400), ms: 1 })),
    usernameLane: async () => "",
    launchGui: async () => {}, readGui: async () => "", synthesize: async () => ({}),
    jevChoose: async () => { n++; throw new Error(`jev: HTTP 500`); },
    apiKey: "k",
  };
  await assert.rejects(runJevResearch(ctx), /HTTP 500/);
  assert.equal(n, 3, `expected 3 tries, got ${n}`);
}

rmSync(tmp, { recursive: true, force: true });
console.log("PASS jev.test.mjs (8 groups)");
