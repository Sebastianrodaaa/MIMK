"use client";
import { useEffect, useState } from "react";
import { ChevronDown, Crown, Zap } from "lucide-react";
import { ORCH, WorldState } from "../lib";

export default function GodTools({ onFollow, twins: propTwins }: {
  onFollow: (personaId: string | null) => void;
  twins?: { id: string; name: string }[];
}) {
  const [tab, setTab] = useState<"event" | "goal" | "conflict" | "whisper" | "state">("event");
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<WorldState>();
  const [err, setErr] = useState("");
  const [pending, setPending] = useState(false);
  const [eventText, setEventText] = useState("");
  const [goalTitle, setGoalTitle] = useState("");
  const [goalPersona, setGoalPersona] = useState("");
  const [cA, setCA] = useState(""); const [cB, setCB] = useState(""); const [cIssue, setCIssue] = useState("");
  const [wPersona, setWPersona] = useState(""); const [wText, setWText] = useState("");

  const refresh = () => fetch(`${ORCH}/world/state`).then((r) => r.json()).then(setState).catch(() => {});
  useEffect(() => { refresh(); const t = setInterval(refresh, 4000); return () => clearInterval(t); }, []);

  async function god(body: any) {
    setPending(true); setErr("");
    try {
      const res = await fetch(`${ORCH}/world/god`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(Array.isArray(j.error) ? j.error.join(", ") : j.error ?? `HTTP ${res.status}`);
      setState(j.state);
    } catch (e: any) { setErr(e?.message ?? String(e)); }
    finally { setPending(false); }
  }

  const twins = propTwins?.length ? propTwins : (state?.twins ?? []);
  const sel = (v: string, set: (s: string) => void, ph: string) => (
    <select value={v} onChange={(e) => set(e.target.value)}
      className="rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5 text-[11px] text-neutral-300">
      <option value="">{ph}</option>
      {twins.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
    </select>
  );
  const input = (v: string, set: (s: string) => void, ph: string, w = "flex-1") => (
    <input value={v} onChange={(e) => set(e.target.value)} placeholder={ph}
      className={`${w} rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-[11px] text-neutral-300 placeholder:text-neutral-600`} />
  );
  const btn = (label: string, onClick: () => void, disabled?: boolean) => (
    <button onClick={onClick} disabled={pending || disabled}
      className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-800 disabled:opacity-40">
      {label}
    </button>
  );

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-950/60">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between px-3 py-2 text-left">
        <span className="flex items-center gap-2 text-xs font-medium text-neutral-300">
          <Crown size={13} className="text-neutral-500" /> God mode
          {state?.director.enabled && <span className="rounded bg-emerald-900/50 px-1.5 py-0.5 text-[10px] text-emerald-300">director {state.director.intervalSec}s</span>}
          {(state?.conflicts.length ?? 0) > 0 && <span className="rounded bg-red-900/50 px-1.5 py-0.5 text-[10px] text-red-300">{state!.conflicts.length} conflicts</span>}
        </span>
        <ChevronDown size={13} className={`text-neutral-500 transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && (
        <div className="space-y-2 px-3 pb-3">
          {err && <p className="text-[11px] text-red-400">{err}</p>}
          <div className="flex flex-wrap items-center gap-1.5">
            {btn(state?.director.enabled ? "Pause director" : "Resume director", () => god({ op: "director", enabled: !state?.director.enabled }))}
            <select value={state?.director.intervalSec ?? 45} onChange={(e) => god({ op: "director", intervalSec: Number(e.target.value) })}
              className="rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5 text-[11px] text-neutral-300">
              {[15, 30, 45, 90].map((s) => <option key={s} value={s}>{s}s</option>)}
            </select>
            {btn("Tick now", () => god({ op: "tick" }))}
            <select onChange={(e) => onFollow(e.target.value || null)} defaultValue=""
              className="rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5 text-[11px] text-neutral-300">
              <option value="">Overview</option>
              {twins.map((t) => <option key={t.id} value={t.id}>Follow {t.name}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            {input(eventText, setEventText, "Event text (or pick a preset)")}
            {btn("Post", () => { god({ op: "event", text: eventText }); setEventText(""); }, !eventText.trim())}
          </div>
          <div className="flex flex-wrap gap-1">
            {(["crisis", "rumor", "windfall", "deadline"] as const).map((p) => (
              <button key={p} onClick={() => god({ op: "event", preset: p })} disabled={pending}
                className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] capitalize text-neutral-400 hover:text-neutral-200">
                {p}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            {sel(goalPersona, setGoalPersona, "Goal for…")}
            {input(goalTitle, setGoalTitle, "title")}
            {btn("Set", () => { god({ op: "goal", persona: goalPersona, title: goalTitle }); setGoalTitle(""); }, !goalPersona || !goalTitle.trim())}
          </div>
          <div className="flex items-center gap-1.5">
            {sel(cA, setCA, "A")} {sel(cB, setCB, "B")}
            {input(cIssue, setCIssue, "issue")}
            {btn("Fight", () => { god({ op: "conflict", a: cA, b: cB, issue: cIssue }); setCIssue(""); }, !cA || !cB || !cIssue.trim())}
          </div>
          <div className="flex items-center gap-1.5">
            {sel(wPersona, setWPersona, "Whisper to…")}
            {input(wText, setWText, "secret directive")}
            {btn("Send", () => { god({ op: "whisper", persona: wPersona, text: wText }); setWText(""); }, !wPersona || !wText.trim())}
          </div>
          {(state?.goals.length ?? 0) > 0 && (
            <div className="space-y-1">
              {state!.goals.map((g) => (
                <div key={g.id} className="text-[10px] text-neutral-400">
                  <span className="text-neutral-300">{twins.find((t) => t.id === g.personaId)?.name ?? g.personaId}</span>: {g.title}
                  <div className="mt-0.5 h-1 w-full rounded bg-neutral-800">
                    <div className="h-1 rounded bg-emerald-600" style={{ width: `${g.progress}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
          {(state?.conflicts.length ?? 0) > 0 && (
            <div className="space-y-1">
              {state!.conflicts.map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-2 text-[10px]">
                  <span className="text-red-300">
                    {twins.find((t) => t.id === c.aId)?.name ?? c.aId} ⚔ {twins.find((t) => t.id === c.bId)?.name ?? c.bId}
                    <span className="text-neutral-500"> ({c.intensity}) {c.issue.slice(0, 50)}</span>
                  </span>
                  {btn("Resolve", () => god({ op: "resolve", conflictId: c.id }))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
