// Lane e2e: spawn mock model on host, run agent container against it, assert events.
import { spawn, execFileSync } from "node:child_process";
import assert from "node:assert";

const MOCK_PORT = 8788;
const RUN = "lane-e2e-run";
const mock = spawn("node", ["test/mock-model-lane.mjs"], {
  env: { ...process.env, MOCK_PORT: String(MOCK_PORT) },
});
await new Promise((r) => setTimeout(r, 800));
try {
  execFileSync("docker", ["rm", "-f", `mimk-agent-${RUN}`], { stdio: "ignore" });
  const out = spawn("docker", ["run", "--rm", "--name", `mimk-agent-${RUN}`,
    "--shm-size", "512m",
    "-e", "DEBUG_HISTORY=1",
    "-e", `TASK=Research Linus Torvalds briefly`,
    "-e", `MODEL_BASE_URL=http://host.docker.internal:${MOCK_PORT}/v1`,
    "-e", "MODEL_NAME=mock", "-e", "MODEL_API_KEY=x", "-e", "MAX_STEPS=12",
    "-e", `RUN_ID=${RUN}`,
    "--add-host", "host.docker.internal:host-gateway",
    "mimk-agent"]);
  let log = "";
  out.stdout.on("data", (d) => (log += d));
  out.stderr.on("data", (d) => (log += d));
  const code = await new Promise((res) => {
    const t = setTimeout(() => res("TIMEOUT"), 300000);
    out.on("close", res);
    out.on("exit", (c) => { clearTimeout(t); res(c); });
  });
  const events = log.split("\n").filter((l) => l.startsWith("{"))
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const kinds = events.map((e) => e.kind);
  console.log("exit:", code, "events:", events.length);
  console.log(events.map((e) => `${e.kind}:${JSON.stringify(e.data).slice(0, 80)}`).join("\n"));
  const laneLogs = events.filter((e) => e.data?.msg === "lane");
  assert(events.some((e) => e.kind === "action" && e.data?.action === "search_person"), "no search_person");
  assert(laneLogs.length >= 2, `lane logs <2: ${laneLogs.length}`);
  assert(events.some((e) => e.kind === "finding" && e.data?.summary?.includes("Finnish-American")), "no note finding");
  assert(events.some((e) => e.kind === "finding" && e.data?.summary?.includes("Lane test complete")), "no done finding");
  assert(events.some((e) => e.data?.msg === "finished" && e.data?.ok === true), "no finished ok");
  // gui-block on the early launch attempt
  assert(events.some((e) => e.data?.msg === "gui blocked"), "no gui blocked event");
  // no duplicate observation pushes: check DEBUG_HISTORY? we check via note count in findings
  assert(events.filter((e) => e.kind === "finding").length >= 7, "structured-done findings missing");
  assert(events.some((e) => e.kind === "finding" && e.data?.summary?.includes("created Git")), "done.findings not emitted");
  assert(!events.some((e) => e.data?.msg === "snapshot failed" && events.indexOf(e) < 4), "unexpected snapshot on lane steps");
  // ctx + model latency events present
  assert(events.some((e) => e.data?.msg === "ctx"), "no ctx log");
  assert(events.some((e) => e.data?.msg === "model"), "no model latency log");
  console.log("PASS lane-loop");
} finally {
  mock.kill();
  try { execFileSync("docker", ["rm", "-f", `mimk-agent-${RUN}`], { stdio: "ignore" }); } catch {}
}
