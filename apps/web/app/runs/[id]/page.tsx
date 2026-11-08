"use client";
import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { ORCH, AgentEvent, AgentRun, vncUrl } from "../../lib";
import { LogViewer, LogLine, LogToolbar, LEVELS, type LogLevel } from "../../components/LogViewer";
import StatusPill from "../../components/StatusPill";

export default function RunPage() {
  const { id } = useParams<{ id: string }>();
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [run, setRun] = useState<AgentRun>();
  const [liveFail, setLiveFail] = useState(false);
  const [shots, setShots] = useState<string[]>([]);
  const [follow, setFollow] = useState(true);
  const [active, setActive] = useState<Set<LogLevel>>(new Set(LEVELS));
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`${ORCH}/runs`).then((r) => r.json())
      .then((rs: AgentRun[]) => setRun(rs.find((x) => x.id === id))).catch(() => {});
    const es = new EventSource(`${ORCH}/runs/${id}/events`);
    es.onmessage = (m) => {
      try {
        const ev = JSON.parse(m.data);
        setEvents((prev) => [...prev, ev]);
        if (ev.kind === "screenshot" && (ev.data as any)?.url)
          setShots((prev) => [...prev.slice(-11), (ev.data as any).url]);
        bottom.current?.scrollIntoView({ behavior: "smooth" });
      } catch {}
    };
    return () => es.close();
  }, [id]);

  const findings = events.filter((e) => e.kind === "finding");
  const levelOf = (e: AgentEvent): LogLevel =>
    e.kind === "finding" ? "success" :
    /error|fail/i.test(JSON.stringify(e.data)) ? "error" :
    /warn/i.test(JSON.stringify(e.data)) ? "warn" :
    e.kind === "action" ? "debug" : "info";
  const counts = Object.fromEntries(LEVELS.map((l) => [l, events.filter((e) => levelOf(e) === l).length])) as Record<LogLevel, number>;
  const fmtTs = (ts: string) => { try { return new Date(ts).toLocaleTimeString(); } catch { return ts; } };

  return (
    <main className="space-y-6">
      <h1 className="font-medium flex items-center gap-3">Run <span className="font-mono text-sky-400">{id.slice(0, 8)}</span>
        {run && <StatusPill variant={run.status === "running" ? "info" : run.status === "done" ? "online" : run.status === "failed" ? "error" : "idle"}>{run.status}</StatusPill>}
      </h1>

      {findings.length > 0 && (
        <section className="border border-emerald-900 rounded-lg p-4 bg-emerald-950/30">
          <h2 className="text-sm font-medium mb-2 text-emerald-300">Findings</h2>
          <ul className="space-y-1 text-sm">
            {findings.map((f, i) => {
              const d = f.data as any;
              return (
                <li key={i}>
                  {d?.summary ?? JSON.stringify(d)}
                  {d?.sourceUrl && (
                    <a className="ml-2 text-sky-400 underline" href={d.sourceUrl}>{d.sourceUrl}</a>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {run?.vncPort && (
        <iframe src={vncUrl(run.vncPort)} className="w-full aspect-[8/5] rounded-lg border border-neutral-800 bg-black" />
      )}

      {run?.backend === "h" && (
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <span className="text-xs px-2 py-0.5 rounded bg-violet-800">H agent</span>
            {(run.liveViewUrl || run.agentViewUrl) && (
              <a className="text-sm text-sky-400 underline" target="_blank"
                href={run.liveViewUrl ?? run.agentViewUrl}>Open live view ↗</a>
            )}
          </div>
          {run.liveViewUrl && !liveFail && (
            <iframe src={run.liveViewUrl} onError={() => setLiveFail(true)}
              className="w-full aspect-[8/5] rounded-lg border border-neutral-800 bg-black" />
          )}
          {shots.length > 0 && (
            <div className="flex gap-2 overflow-x-auto">
              {shots.slice(-6).map((u, i) => (
                <img key={i} src={u} className="h-24 rounded border border-neutral-800" />
              ))}
            </div>
          )}
        </div>
      )}

      <section>
        <LogToolbar follow={follow} onFollow={setFollow} counts={counts} active={active}
          onToggle={(l) => setActive((a) => { const n = new Set(a); n.has(l) ? n.delete(l) : n.add(l); return n; })} />
        <LogViewer follow={follow} className="h-96">
          {events.filter((e) => active.has(levelOf(e))).map((e, i) => (
            <LogLine key={i} level={levelOf(e)} time={fmtTs(e.ts)} source={e.kind}>
              {typeof e.data === "string" ? e.data : JSON.stringify(e.data)}
            </LogLine>
          ))}
        </LogViewer>
      </section>
    </main>
  );
}
