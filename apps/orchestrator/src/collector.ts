import type Docker from "dockerode";
import type { Db } from "./db.js";
import { createLogDemuxer, parseEventLine } from "./events.js";

const attached = new Set<string>();

export async function attachCollector(
  run: { id: string; subjectId: string; containerId?: string },
  docker: Docker,
  db: Db
) {
  if (!run.containerId || attached.has(run.id)) return;
  attached.add(run.id);
  let finished = false;
  try {
    const stream = await docker.getContainer(run.containerId).logs({
      stdout: true, stderr: false, follow: true,
    });
    let buf = "";
    const demux = createLogDemuxer();
    stream.on("data", (chunk: Buffer) => {
      buf += demux(chunk).toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        const ev = parseEventLine(line, run.id);
        if (ev?.kind === "finding") {
          const d = ev.data as any;
          db.addFinding({
            runId: run.id,
            subjectId: run.subjectId,
            sourceUrl: String(d?.sourceUrl ?? ""),
            summary: String(d?.summary ?? ""),
            ts: String(d?.ts ?? ev.ts),
          });
        }
        if (ev?.kind === "log" && (ev.data as any)?.msg === "finished") {
          finished = true;
          db.updateRun(run.id, { status: (ev.data as any).ok ? "done" : "failed" });
        }
      }
    });
    stream.on("error", () => { attached.delete(run.id); onStreamEnd(); });
    stream.on("end", () => { attached.delete(run.id); onStreamEnd(); });
  } catch {
    attached.delete(run.id);
    db.updateRun(run.id, { status: "failed" });
  }

  function onStreamEnd() {
    if (!finished) db.updateRun(run.id, { status: "failed" });
  }
}

export async function reattachCollectors(docker: Docker, db: Db) {
  try {
    const containers = await docker.listContainers({
      filters: { label: ["mimk.run"], status: ["running"] } as any,
    });
    for (const c of containers) {
      const runId = c.Labels?.["mimk.run"];
      const subjectId = c.Labels?.["mimk.subject"];
      const run = runId && db.getRun(runId);
      if (run) await attachCollector({ ...run, subjectId: run.subjectId }, docker, db);
      else if (runId && subjectId)
        await attachCollector({ id: runId, subjectId, containerId: c.Id }, docker, db);
    }
  } catch {}
  for (const run of db.listRuns()) {
    if (run.status !== "running" || run.backend !== "docker" || !run.containerId) continue;
    try {
      const info = await docker.getContainer(run.containerId).inspect();
      if (!(info as any).State?.Running)
        db.updateRun(run.id, { status: (info as any).State?.ExitCode === 0 ? "done" : "failed" });
    } catch {
      db.updateRun(run.id, { status: "failed" });
    }
  }
}
