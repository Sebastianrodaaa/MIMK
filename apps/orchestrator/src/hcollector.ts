import { filterSensitive, type AgentEvent, type AgentRun } from "@mimk/shared";
import type { Db } from "./db.js";
import type { HClient } from "./hagents.js";

const TERMINAL = new Set(["completed", "failed", "timed_out", "interrupted"]);
const buffers = new Map<string, { events: AgentEvent[]; subs: Set<(e: AgentEvent) => void> }>();
const polling = new Set<string>();

export function getBuffer(runId: string) {
  let b = buffers.get(runId);
  if (!b) {
    b = { events: [], subs: new Set() };
    buffers.set(runId, b);
  }
  return b;
}

export function pushEvent(runId: string, ev: AgentEvent) {
  const b = getBuffer(runId);
  b.events.push(ev);
  if (b.events.length > 500) b.events.splice(0, b.events.length - 500);
  for (const s of b.subs) s(ev);
}

export function subscribe(runId: string, cb: (e: AgentEvent) => void) {
  const b = getBuffer(runId);
  b.subs.add(cb);
  return { buffered: b.events.slice(), close: () => b.subs.delete(cb) };
}

export function mapHEvent(runId: string, ev: any): AgentEvent | null {
  const ts = ev?.timestamp ?? new Date().toISOString();
  if (ev?.type === "LiveViewUrlEvent")
    return { runId, ts, kind: "log", data: { msg: "live view", url: ev.data?.live_view_url } };
  if (ev?.type === "AgentEvent") {
    const d = ev.data ?? {};
    if (d.kind === "policy_event") {
      const content = typeof d.content === "string" ? d.content : "";
      return {
        runId, ts, kind: "action",
        data: { text: String(d.reasoning_content ?? content).slice(0, 200), tool_reqs: d.tool_reqs },
      };
    }
    if (d.kind === "observation_event")
      return {
        runId, ts, kind: "screenshot",
        data: { url: d.image?.source, pageUrl: d.metadata?.url, title: d.metadata?.title },
      };
    if (d.kind === "answer_event")
      return { runId, ts, kind: "finding", data: { answer: d.answer, outcome: d.outcome } };
    if (d.kind === "error_event")
      return { runId, ts, kind: "log", data: { msg: "agent error", err: d.error } };
    return null;
  }
  if (ev?.type === "AgentErrorEvent")
    return { runId, ts, kind: "log", data: { msg: "error", err: ev.data } };
  if (ev?.type === "AgentCompletionEvent")
    return { runId, ts, kind: "log", data: { msg: "completed", data: ev.data } };
  return null;
}

export function persistAnswer(run: AgentRun, answer: any, db: Db) {
  const findings = Array.isArray(answer?.findings) ? answer.findings : [];
  for (const f of findings) {
    const summary = filterSensitive(String(f?.summary ?? ""));
    const sourceUrl = String(f?.sourceUrl ?? "");
    db.addFinding({ runId: run.id, subjectId: run.subjectId, sourceUrl, summary, ts: new Date().toISOString() });
    pushEvent(run.id, { runId: run.id, ts: new Date().toISOString(), kind: "finding", data: { runId: run.id, sourceUrl, summary, ts: new Date().toISOString() } });
  }
}

export async function pollHRun(run: AgentRun, client: HClient, db: Db) {
  if (!run.hSessionId || polling.has(run.id)) return;
  polling.add(run.id);
  let fromIndex = 0;
  try {
    while (true) {
      const cur = db.getRun(run.id);
      if (!cur || cur.status !== "running") break;
      const res: any = await client.getChanges(run.hSessionId, fromIndex);
      if (!res) { await new Promise((r) => setTimeout(r, 5000)); continue; }
      const status = res.status?.status ?? res.status;
      for (const ev of res.new_events ?? []) {
        if (ev.type === "LiveViewUrlEvent" && ev.data?.live_view_url && !cur.liveViewUrl)
          db.updateRun(run.id, { liveViewUrl: ev.data.live_view_url });
        const mapped = mapHEvent(run.id, ev);
        if (mapped) pushEvent(run.id, mapped);
      }
      if (res.answer) persistAnswer(run, res.answer, db);
      fromIndex = (res.first_index ?? fromIndex) + (res.new_events?.length ?? 0);
      if (TERMINAL.has(status)) {
        db.updateRun(run.id, { status: status === "completed" ? "done" : "failed" });
        if (status !== "completed")
          pushEvent(run.id, { runId: run.id, ts: new Date().toISOString(), kind: "log", data: { msg: `session ${status}`, error_code: res.error_code ?? res.error } });
        break;
      }
      if (!(res.new_events?.length)) await new Promise((r) => setTimeout(r, 2000));
    }
  } catch (e: any) {
    pushEvent(run.id, { runId: run.id, ts: new Date().toISOString(), kind: "log", data: { msg: "poller error", err: String(e?.message ?? e) } });
    db.updateRun(run.id, { status: "failed" });
  } finally {
    polling.delete(run.id);
  }
}
