#!/usr/bin/env node
import { Command } from "commander";

const ORCH = process.env.ORCHESTRATOR_URL ?? "http://localhost:4000";

async function post(path: string, body: unknown) {
  const res = await fetch(`${ORCH}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) {
    console.error(`error ${res.status}:`, JSON.stringify(json));
    process.exit(1);
  }
  return json;
}

const program = new Command();
program.name("mimk").description("MIMK investigation CLI");

const subject = program.command("subject");
subject
  .command("add")
  .requiredOption("--name <name>")
  .requiredOption("--type <type>", "volunteer | public_figure")
  .requiredOption("--source <source...>", "approved sources")
  .action(async (o) => {
    const s = await post("/subjects", { name: o.name, type: o.type, approvedSources: o.source });
    console.log(s.id);
  });
subject.command("list").action(async () => {
  console.table(await (await fetch(`${ORCH}/subjects`)).json());
});

const run = program.command("run");
run
  .command("start")
  .requiredOption("--subject <id>")
  .option("--count <n>", "agents", "1")
  .action(async (o) => {
    const runs = await post("/runs", { subjectId: o.subject, count: Number(o.count) });
    for (const r of runs) console.log(r.id, r.status);
  });
run.command("list").action(async () => {
  console.table(await (await fetch(`${ORCH}/runs`)).json());
});
run.command("logs").argument("<id>").action(async (id) => {
  const res = await fetch(`${ORCH}/runs/${id}/events`);
  if (!res.ok || !res.body) {
    console.error(`error ${res.status}`);
    process.exit(1);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of dec.decode(value).split("\n"))
      if (line.startsWith("data: ")) console.log(line.slice(6));
  }
});
run.command("kill").argument("<id>").action(async (id) => {
  const res = await fetch(`${ORCH}/runs/${id}`, { method: "DELETE" });
  console.log(res.ok ? "killed" : `error ${res.status}`);
});

program.parse();
