"use client";
import { createContext, useContext, useEffect, useState } from "react";
import { Camera, ExternalLink, MonitorPlay, X } from "lucide-react";
import { ORCH, VNC_HOST, AgentEvent, AgentRun, vncUrl } from "../lib";
import StatusPill, { type StatusVariant } from "./StatusPill";
import { cn } from "./utils";

const TERMINAL = new Set(["done", "failed"]);
const RunsCtx = createContext<Map<string, AgentRun>>(new Map());

function useRuns(runIds: string[]) {
  const [runs, setRuns] = useState<Map<string, AgentRun>>(new Map());
  const key = runIds.join(",");
  useEffect(() => {
    let stop = false;
    const load = () =>
      fetch(`${ORCH}/runs`).then((r) => r.json()).then((rs: AgentRun[]) => {
        if (stop) return;
        setRuns(new Map(rs.filter((r) => runIds.includes(r.id)).map((r) => [r.id, r])));
      }).catch(() => {});
    load();
    const t = setInterval(() => {
      load();
      setRuns((cur) => {
        if (runIds.every((id) => TERMINAL.has(cur.get(id)?.status ?? ""))) clearInterval(t);
        return cur;
      });
    }, 3000);
    return () => { stop = true; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return runs;
}

function useRunEvents(runId: string, active: boolean) {
  const [shot, setShot] = useState<string>();
  const [summary, setSummary] = useState<string>();
  const [findings, setFindings] = useState<{ summary: string; sourceUrl?: string }[]>([]);
  useEffect(() => {
    const es = new EventSource(`${ORCH}/runs/${runId}/events`);
    es.onmessage = (m) => {
      try {
        const ev = JSON.parse(m.data) as AgentEvent;
        if (ev.kind === "screenshot" && (ev.data as any)?.url) setShot((ev.data as any).url);
        if (ev.kind === "finding") {
          const d = ev.data as any;
          if (d?.answer) {
            let a = d.answer;
            if (typeof a === "string") { try { a = JSON.parse(a); } catch {} }
            if (a?.summary) setSummary(String(a.summary));
          } else if (d?.summary && !d.sourceUrl) {
            setSummary(String(d.summary));
          } else if (d?.summary) {
            setFindings((prev) =>
              prev.some((f) => f.summary === d.summary && f.sourceUrl === d.sourceUrl)
                ? prev
                : [...prev, { summary: String(d.summary), sourceUrl: d.sourceUrl }]
            );
          }
        }
      } catch {}
    };
    if (!active) es.close();
    return () => es.close();
  }, [runId, active]);
  return { shot, summary, findings };
}

const pillVariant = (s?: string): StatusVariant =>
  s === "running" ? "info" : s === "done" ? "online" : s === "failed" ? "error" : "idle";

function Screen({ run, shot, mode, big, vnc }: {
  run?: AgentRun; shot?: string; mode: "live" | "shot"; big?: boolean;
  vnc?: { src?: string; state: "starting" | "ready" | "closed" };
}) {
  const live = run?.liveViewUrl;
  const placeholder = (text: string) => (
    <div className="flex h-full items-center justify-center text-xs text-neutral-500">
      <span className={text === "Starting computer…" ? "animate-pulse" : ""}>{text}</span>
    </div>
  );
  return (
    <div className={cn("relative w-full overflow-hidden rounded-lg border border-neutral-800 bg-black", "aspect-[16/10]")}>
      {vnc ? (
        vnc.state === "ready" && vnc.src ? (
          <iframe src={vnc.src} title="agent live desktop" className="h-full w-full" />
        ) : vnc.state === "closed" ? (
          placeholder("Desktop closed")
        ) : (
          placeholder("Starting computer…")
        )
      ) : mode === "live" && live ? (
        <iframe src={live} title="agent live view" className="h-full w-full" />
      ) : shot ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={shot} alt="latest agent screenshot" className="h-full w-full object-contain" />
      ) : (
        placeholder("Starting computer…")
      )}
    </div>
  );
}

function AgentTile({ runId }: { runId: string }) {
  const runs = useContext(RunsCtx);
  const run = runs.get(runId);
  const active = !TERMINAL.has(run?.status ?? "running");
  const { shot, summary, findings } = useRunEvents(runId, active);
  const [mode, setMode] = useState<"live" | "shot">("live");
  const [open, setOpen] = useState(false);
  const [twinState, setTwinState] = useState<"idle" | "building" | "done" | "error">("idle");
  const [twinError, setTwinError] = useState<string>();
  const isDocker = run?.backend === "docker";
  const osint = !!run && run.subjectId !== "_chat";
  const link = isDocker && run?.vncPort ? vncUrl(run.vncPort) : run?.liveViewUrl ?? run?.agentViewUrl;

  const [vncState, setVncState] = useState<"starting" | "ready" | "closed">("starting");
  useEffect(() => {
    const port = run?.vncPort;
    if (!isDocker || !port) return;
    let cancelled = false;
    let wasReady = false;
    let attempts = 0;
    const probe = async () => {
      try {
        await fetch(`http://${VNC_HOST}:${port}/vnc.html`, { mode: "no-cors" });
        if (cancelled) return;
        wasReady = true;
        setVncState("ready");
      } catch {
        if (cancelled) return;
        if (wasReady || TERMINAL.has(run.status)) setVncState("closed");
        else if (++attempts >= 30) setVncState("closed");
      }
    };
    probe();
    const t = setInterval(probe, 1000);
    return () => { cancelled = true; clearInterval(t); };
  }, [isDocker, run?.vncPort, run?.status]);

  async function buildTwin() {
    if (!run) return;
    setTwinState("building");
    try {
      const res = await fetch(`${ORCH}/subjects/${run.subjectId}/pipeline`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setTwinState("done");
    } catch (e: any) {
      setTwinState("error");
      setTwinError(e?.message ?? String(e));
    }
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div>
      <div className="group relative">
        <button type="button" aria-label="Enlarge agent screen" onClick={() => setOpen(true)} className="block w-full">
          <Screen run={run} shot={shot} mode={mode}
            vnc={isDocker ? { src: run?.vncPort ? vncUrl(run.vncPort) : undefined, state: vncState } : undefined} />
        </button>
        <div className="absolute right-1.5 top-1.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          {!isDocker && shot && (
            <button
              type="button"
              aria-label={mode === "live" ? "Show latest screenshot" : "Show live view"}
              onClick={() => setMode(mode === "live" ? "shot" : "live")}
              className="rounded-md border border-neutral-700 bg-neutral-900/90 p-1 text-neutral-400 hover:text-neutral-100"
            >
              {mode === "live" ? <Camera size={12} /> : <MonitorPlay size={12} />}
            </button>
          )}
          {link && (
            <a
              href={link} target="_blank" rel="noreferrer" aria-label="Open agent view"
              className="rounded-md border border-neutral-700 bg-neutral-900/90 p-1 text-neutral-400 hover:text-neutral-100"
            >
              <ExternalLink size={12} />
            </a>
          )}
          {run?.status === "running" && (
            <button
              type="button" aria-label="Stop agent"
              onClick={() => fetch(`${ORCH}/runs/${runId}`, { method: "DELETE" }).catch(() => {})}
              className="rounded-md border border-neutral-700 bg-neutral-900/90 p-1 text-neutral-400 hover:text-red-300"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>
      <div className="mt-1.5 flex items-start justify-between gap-2">
        <p className="line-clamp-2 min-w-0 flex-1 text-xs text-neutral-400">{run?.task ?? "Agent task"}</p>
        <StatusPill variant={pillVariant(run?.status)}>{run?.status ?? "queued"}</StatusPill>
      </div>
      {summary && <p className="mt-1 text-xs text-emerald-300">{summary}</p>}
      {osint && findings.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {findings.slice(0, 3).map((f, i) => (
            <li key={i} className="truncate text-[11px] text-neutral-500">
              {f.summary}
              {f.sourceUrl && (
                <a href={f.sourceUrl} target="_blank" rel="noreferrer" className="ml-1 text-sky-400 hover:underline">
                  source
                </a>
              )}
            </li>
          ))}
          {findings.length > 3 && (
            <li className="text-[11px] text-neutral-600">+{findings.length - 3} more</li>
          )}
        </ul>
      )}
      {osint && run?.status === "done" && (
        <div className="mt-1.5 flex items-center gap-2 text-[11px]">
          {twinState === "done" ? (
            <a href="/world" className="text-sky-400 hover:underline">Open world →</a>
          ) : (
            <button
              type="button"
              onClick={buildTwin}
              disabled={twinState === "building"}
              className="rounded-md border border-neutral-700 px-2 py-0.5 text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
            >
              {twinState === "building" ? "Building…" : "Build twin"}
            </button>
          )}
          <a href={`/subjects/${run.subjectId}`} className="text-sky-400 hover:underline">Dossier</a>
          {twinState === "error" && <span className="text-red-400">{twinError}</span>}
        </div>
      )}

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
          onClick={() => setOpen(false)} role="dialog" aria-modal="true" aria-label="Agent screen"
        >
          <div className="w-full max-w-4xl" onClick={(e) => e.stopPropagation()}>
            <Screen run={run} shot={shot} mode={mode} big
              vnc={isDocker ? { src: run?.vncPort ? vncUrl(run.vncPort) : undefined, state: vncState } : undefined} />
            <p className="mt-2 text-xs text-neutral-400">{run?.task}</p>
          </div>
        </div>
      )}
    </div>
  );
}

export default function AgentGrid({ runIds }: { runIds: string[] }) {
  const runs = useRuns(runIds);
  return (
    <RunsCtx.Provider value={runs}>
      <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {runIds.map((id) => <AgentTile key={id} runId={id} />)}
      </div>
    </RunsCtx.Provider>
  );
}
