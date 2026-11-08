"use client";
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { ORCH, Persona } from "../lib";

type Profile = {
  persona: Persona;
  dossier: { summary: string; facts: { claim: string; sourceUrl: string; confidence: number }[] } | null;
  findings: { summary: string; sourceUrl: string; ts: string }[];
  goals: { id: string; title: string; progress: number; status: string }[];
  conflicts: { id: string; issue: string; intensity: number; status: string; otherName?: string }[];
  recent: { id: number; ts: string; kind: string; text: string }[];
  relationships: { otherId: string; otherName: string; affinity: number; status: string; topic: string | null }[];
  memories: { ts: string; kind: string; text: string; source: string | null }[];
  interactions: { ts: string; otherId: string; otherName: string; summary: string; intent: string; delta: number }[];
};

const KIND_COLOR: Record<string, string> = {
  person: "bg-sky-900/60 text-sky-300",
  company: "bg-violet-900/60 text-violet-300",
  business: "bg-violet-900/60 text-violet-300",
  task: "bg-amber-900/60 text-amber-300",
  idea: "bg-emerald-900/60 text-emerald-300",
  other: "bg-neutral-800 text-neutral-400",
};

export default function ProfileDrawer({ twinId, onClose, onOpen }: {
  twinId: string; onClose: () => void; onOpen?: (id: string) => void;
}) {
  const [p, setP] = useState<Profile | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    setP(null);
    setErr("");
    fetch(`${ORCH}/twins/${twinId}/profile`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setP)
      .catch((e) => setErr(e?.message ?? String(e)));
  }, [twinId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const persona = p?.persona;
  return (
    <div className="absolute inset-y-0 right-0 z-30 flex w-80 flex-col overflow-y-auto border-l border-neutral-800 bg-neutral-950/95 shadow-2xl">
      <div className="flex items-start justify-between gap-2 border-b border-neutral-800 p-3">
        <div className="flex items-center gap-2.5">
          {persona && (
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold"
              style={{ background: persona.avatar.palette[1] ?? "#333", color: persona.avatar.palette[2] ?? "#eee" }}>
              {persona.name.slice(0, 1).toUpperCase()}
            </span>
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <h3 className="truncate text-sm font-medium text-neutral-100">{persona?.name ?? "…"}</h3>
              {persona?.kind && (
                <span className={`rounded px-1.5 py-0.5 text-[10px] ${KIND_COLOR[persona.kind] ?? KIND_COLOR.other}`}>
                  {persona.kind}
                </span>
              )}
            </div>
            {persona && <p className="mt-0.5 line-clamp-2 text-[11px] text-neutral-500">{persona.bio}</p>}
          </div>
        </div>
        <button type="button" aria-label="Close profile" onClick={onClose}
          className="text-neutral-500 hover:text-neutral-200">
          <X size={14} />
        </button>
      </div>

      {err && <p className="p-3 text-xs text-red-400">{err}</p>}
      {!p && !err && <p className="p-3 text-xs text-neutral-500">Loading…</p>}

      {p && persona && (
        <div className="space-y-4 p-3 text-xs">
          <div>
            <div className="flex flex-wrap gap-1">
              {persona.traits.map((t) => (
                <span key={t} className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-300">{t}</span>
              ))}
              {persona.interests.map((t) => (
                <span key={t} className="rounded bg-neutral-800/60 px-1.5 py-0.5 text-[10px] text-neutral-500">{t}</span>
              ))}
            </div>
          </div>

          {persona.stances.length > 0 && (
            <section>
              <h4 className="mb-1 text-[10px] font-medium uppercase tracking-wide text-neutral-500">Stances</h4>
              <ul className="list-disc space-y-0.5 pl-4 text-neutral-300">
                {persona.stances.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </section>
          )}
          {persona.relationships.length > 0 && (
            <section>
              <h4 className="mb-1 text-[10px] font-medium uppercase tracking-wide text-neutral-500">Relationships</h4>
              <ul className="list-disc space-y-0.5 pl-4 text-neutral-300">
                {persona.relationships.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </section>
          )}
          <section>
            <h4 className="mb-1 text-[10px] font-medium uppercase tracking-wide text-neutral-500">Speech style</h4>
            <p className="text-neutral-400">{persona.speechStyle}</p>
          </section>

          {p.relationships.length > 0 && (
            <section>
              <h4 className="mb-1 text-[10px] font-medium uppercase tracking-wide text-neutral-500">Relationships</h4>
              <div className="space-y-1.5">
                {p.relationships.map((r) => (
                  <div key={r.otherId}>
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => onOpen?.(r.otherId)}
                        className="truncate text-neutral-200 hover:text-sky-300 hover:underline"
                      >
                        {r.otherName}
                      </button>
                      <span className={`shrink-0 rounded px-1 py-0.5 text-[9px] ${
                        r.status === "ally" ? "bg-emerald-900/60 text-emerald-300"
                        : r.status === "rival" ? "bg-red-900/60 text-red-300"
                        : "bg-neutral-800 text-neutral-500"}`}>
                        {r.status}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-1">
                      <div className="h-1 flex-1 rounded bg-neutral-800">
                        <div
                          className={`h-1 rounded ${r.affinity >= 0 ? "bg-emerald-600" : "bg-red-600"}`}
                          style={{ width: `${Math.min(100, Math.abs(r.affinity))}%` }}
                        />
                      </div>
                      <span className="w-6 text-right text-[9px] text-neutral-600">{r.affinity}</span>
                    </div>
                    {r.topic && <p className="text-[10px] text-neutral-600">re: {r.topic}</p>}
                  </div>
                ))}
              </div>
            </section>
          )}

          {p.memories.length > 0 && (
            <section>
              <h4 className="mb-1 text-[10px] font-medium uppercase tracking-wide text-neutral-500">Remembers</h4>
              <ul className="space-y-1">
                {p.memories.map((m, i) => (
                  <li key={i} className="text-neutral-400">
                    <span className="text-neutral-600">
                      {m.kind === "rumor" ? "🗞 " : m.kind === "event" ? "⚡ " : m.kind === "reflection" ? "💭 " : ""}
                    </span>
                    {m.text}
                    {m.source && <span className="text-neutral-600"> (heard from {m.source})</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {p.interactions.length > 0 && (
            <section>
              <h4 className="mb-1 text-[10px] font-medium uppercase tracking-wide text-neutral-500">Recent conversations</h4>
              <ul className="space-y-1">
                {p.interactions.map((i, n) => (
                  <li key={n} className="text-neutral-400">
                    <button
                      type="button"
                      onClick={() => onOpen?.(i.otherId)}
                      className="text-neutral-300 hover:text-sky-300 hover:underline"
                    >
                      {i.otherName}
                    </button>
                    <span className="text-neutral-600"> · {i.intent} · {i.delta > 0 ? "+" : ""}{i.delta}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {(p.dossier || p.findings.length > 0) && (
            <section>
              <h4 className="mb-1 text-[10px] font-medium uppercase tracking-wide text-neutral-500">Research</h4>
              {p.dossier?.summary && <p className="mb-1.5 text-neutral-400">{p.dossier.summary}</p>}
              <ul className="space-y-1">
                {(p.dossier?.facts.length ? p.dossier.facts : p.findings.map((f) => ({ claim: f.summary, sourceUrl: f.sourceUrl, confidence: 0.5 }))).map((f, i) => (
                  <li key={i} className="text-neutral-300">
                    {f.sourceUrl ? (
                      <a href={f.sourceUrl} target="_blank" rel="noreferrer" className="hover:text-sky-300 hover:underline">
                        {f.claim}
                      </a>
                    ) : (
                      f.claim
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {p.goals.length > 0 && (
            <section>
              <h4 className="mb-1 text-[10px] font-medium uppercase tracking-wide text-neutral-500">Goals</h4>
              <div className="space-y-1.5">
                {p.goals.map((g) => (
                  <div key={g.id}>
                    <p className="text-neutral-300">{g.title} <span className="text-neutral-600">({g.status})</span></p>
                    <div className="mt-0.5 h-1 w-full rounded bg-neutral-800">
                      <div className="h-1 rounded bg-emerald-600" style={{ width: `${g.progress}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {p.conflicts.length > 0 && (
            <section>
              <h4 className="mb-1 text-[10px] font-medium uppercase tracking-wide text-neutral-500">Conflicts</h4>
              <ul className="space-y-1 text-neutral-300">
                {p.conflicts.map((c) => (
                  <li key={c.id}>
                    <span className="text-red-300">{c.otherName ?? "?"}</span> — {c.issue}
                    <span className="text-neutral-600"> ({c.intensity}, {c.status})</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {p.recent.length > 0 && (
            <section>
              <h4 className="mb-1 text-[10px] font-medium uppercase tracking-wide text-neutral-500">Recent activity</h4>
              <ul className="space-y-1">
                {p.recent.map((e) => (
                  <li key={e.id} className="text-neutral-400">
                    <span className="text-neutral-600">{e.kind}: </span>{e.text}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
