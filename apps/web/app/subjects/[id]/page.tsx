"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { ORCH, AgentRun, Subject, vncUrl } from "../../lib";
import StatusPill from "../../components/StatusPill";

export default function SubjectPage() {
  const { id } = useParams<{ id: string }>();
  const [subject, setSubject] = useState<Subject>();
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [built, setBuilt] = useState("");

  useEffect(() => {
    const load = () => {
      fetch(`${ORCH}/subjects`).then((r) => r.json())
        .then((s: Subject[]) => setSubject(s.find((x) => x.id === id))).catch(() => {});
      fetch(`${ORCH}/runs`).then((r) => r.json())
        .then((rs: AgentRun[]) => setRuns(rs.filter((x) => x.subjectId === id))).catch(() => {});
    };
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [id]);

  return (
    <main className="space-y-6">
      <div className="flex items-center gap-4">
        <h1 className="font-medium text-lg">{subject?.name ?? id.slice(0, 8)}
          <span className="ml-3 text-sm text-neutral-500">{runs.length} agent(s)</span>
        </h1>
        <button
          onClick={async () => {
            const res = await fetch(`${ORCH}/subjects/${id}/pipeline`, {
              method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
            });
            setBuilt(res.ok ? "twin built" : `error ${res.status}`);
          }}
          className="bg-violet-600 text-white rounded px-4 py-1.5 text-sm font-medium">
          Build twin
        </button>
        {built && <a href="/world" className="text-sm text-sky-400">{built} — open world →</a>}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {runs.map((r) => (
          <div key={r.id} className="rounded-xl border border-neutral-800 bg-neutral-900/50 overflow-hidden">
            <div className="px-3 py-1.5 text-xs flex justify-between bg-neutral-900">
              <a className="font-mono text-sky-400" href={`/runs/${r.id}`}>{r.id.slice(0, 8)}</a>
              <span>
                <span className="mr-2 text-xs px-1.5 py-0.5 rounded bg-neutral-800">{r.backend ?? "docker"}</span>
                <StatusPill variant={r.status === "running" ? "info" : r.status === "done" ? "online" : r.status === "failed" ? "error" : "idle"}>{r.status}</StatusPill>
              </span>
            </div>
            {r.backend === "h" ? (
              <div className="aspect-[8/5] flex flex-col items-center justify-center gap-2 text-sm">
                <span className="text-violet-400">H cloud agent — {r.status}</span>
                {(r.liveViewUrl || r.agentViewUrl) && (
                  <a className="text-sky-400 underline" target="_blank"
                    href={r.liveViewUrl ?? r.agentViewUrl}>Open live view ↗</a>
                )}
                <a className="text-neutral-400 underline" href={`/runs/${r.id}`}>event log →</a>
              </div>
            ) : r.vncPort ? (
              <iframe src={vncUrl(r.vncPort)} className="w-full aspect-[8/5] bg-black" />
            ) : (
              <div className="aspect-[8/5] flex items-center justify-center text-neutral-600 text-sm">
                {r.status === "running" ? "starting display…" : r.status}
              </div>
            )}
          </div>
        ))}
      </div>
    </main>
  );
}
