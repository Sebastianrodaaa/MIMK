"use client";
import { useEffect, useRef, useState } from "react";
import { ORCH, FeedEvent, Persona, Pulse } from "../lib";
import GodTools from "./GodTools";
import { Crown } from "lucide-react";
import { Users, X } from "lucide-react";
import PromptComposer from "@/components/ui/prompt-composer";
import { cn } from "@/lib/utils";

type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "event"; ev: FeedEvent };

const PALETTE = ["text-sky-300", "text-emerald-300", "text-amber-300", "text-violet-300", "text-rose-300", "text-cyan-300"];
const colorFor = (id: string) => {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
};
const SUGGESTIONS = [
  "Set a goal for Ada: dig into the latest research",
  "Make Ada and Marco rivals over the new findings",
  "Pause the director",
  "Announce: free pizza in the kitchen",
];
const DEMO_SUGGESTIONS = [
  "Announce: free pizza in the kitchen",
  "Rumor: the office is moving to another city",
  "Breaking: a rival company just launched a competing product",
  "The coffee machine just broke",
];

export default function WorldChat({ onSpeak, onMeet, twins = [], onRemove, onRemoveAll, onFollow, onProfile, demo }: {
  onFollow?: (personaId: string | null) => void;
  onSpeak: (personaId: string, text: string) => void;
  onMeet?: (aId: string, bId: string) => void;
  twins?: Persona[];
  onRemove?: (id: string) => void;
  onRemoveAll?: () => void;
  onProfile?: (id: string) => void;
  demo?: boolean;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [generating, setGenerating] = useState(false);
  const [simStatus, setSimStatus] = useState("");
  const [simNotice, setSimNotice] = useState("");
  const [rosterOpen, setRosterOpen] = useState(false);
  const [godOpen, setGodOpen] = useState(false);
  const [godInfo, setGodInfo] = useState<{ d: string; c: number }>();
  useEffect(() => {
    let stop = false;
    const poll = () => fetch(`${ORCH}/world/state`).then((r) => r.json()).then((st) => {
      if (!stop) setGodInfo({ d: `${st.director.enabled ? st.director.intervalSec + "s" : "off"}`, c: st.conflicts.length });
    }).catch(() => {});
    poll();
    const t = setInterval(poll, godOpen ? 4000 : 8000);
    return () => { stop = true; clearInterval(t); };
  }, [godOpen]);
  useEffect(() => {
    if (!godOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setGodOpen(false); };
    const onDown = (e: MouseEvent) => { if (!(e.target as HTMLElement)?.closest?.(".god-drawer,.god-btn")) setGodOpen(false); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mousedown", onDown); };
  }, [godOpen]);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const seen = useRef(new Set<number>());
  const abort = useRef<AbortController | undefined>(undefined);
  const scroll = useRef<HTMLDivElement>(null);
  const speakRef = useRef(onSpeak);
  speakRef.current = onSpeak;
  const meetRef = useRef(onMeet);
  meetRef.current = onMeet;
  const [pulse, setPulse] = useState<Pulse>();

  useEffect(() => {
    let stop = false;
    const load = () => {
      if (document.visibilityState !== "visible") return;
      fetch(`${ORCH}/world/pulse`).then((r) => r.json()).then((p) => { if (!stop) setPulse(p); }).catch(() => {});
    };
    load();
    const t = setInterval(load, 6000);
    return () => { stop = true; clearInterval(t); };
  }, []);

  useEffect(() => {
    const es = new EventSource(`${ORCH}/world/feed`);
    es.onmessage = (m) => {
      try {
        const ev = JSON.parse(m.data) as FeedEvent;
        if (seen.current.has(ev.id)) return;
        seen.current.add(ev.id);
        setItems((prev) => [...prev, { kind: "event", ev }]);
        if (!ev.history && ev.personaId !== "_god") {
          speakRef.current(ev.personaId, ev.text);
          if (ev.targetId) meetRef.current?.(ev.personaId, ev.targetId);
        }
      } catch {}
    };
    return () => es.close();
  }, []);

  useEffect(() => {
    const load = () =>
      fetch(`${ORCH}/sim/status`).then((r) => r.json()).then((d: any) => setSimStatus(String(d.status ?? ""))).catch(() => {});
    load();
    const t = setInterval(load, 4000);
    fetch(`${ORCH}/status`).then((r) => r.json()).then((st: any) => {
      if (st.simReason) setSimNotice(st.simReason);
      else if (st.sim === "mirofish") setSimNotice(`mirofish @ ${st.mirofish ?? ""}`);
    }).catch(() => {});
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: "smooth" });
  }, [items]);

  async function send(text: string) {
    const history = items
      .filter((i): i is Extract<Item, { kind: "user" | "assistant" }> => i.kind !== "event")
      .map((i) => ({ role: i.kind, content: i.text }));
    const next = [...items, { kind: "user" as const, text }];
    setItems(next);
    setGenerating(true);
    abort.current = new AbortController();
    try {
      const res = await fetch(`${ORCH}/world/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ messages: [...history, { role: "user", content: text }].slice(-20) }),
        signal: abort.current.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setItems((m) => [...m, { kind: "assistant", text: data.reply }]);
    } catch (e: any) {
      if (e?.name !== "AbortError")
        setItems((m) => [...m, { kind: "assistant", text: `Error: ${e?.message ?? e}` }]);
    } finally {
      setGenerating(false);
    }
  }

  const empty = items.length === 0;

  return (
    <aside className="relative flex h-full w-96 shrink-0 flex-col rounded-lg border border-neutral-800 bg-neutral-900/50">
      {godOpen && (
        <div className="god-drawer absolute inset-x-2 bottom-16 z-20 max-h-[55%] overflow-y-auto rounded-lg border border-neutral-700 bg-neutral-900 p-3 shadow-xl">
          <GodTools onFollow={(id) => onFollow?.(id)} twins={twins} demo={demo} />
        </div>
      )}
      <div className="border-b border-neutral-800 px-3 py-2">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-sm font-medium">World chat</h3>
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="God mode"
              className="god-btn flex items-center gap-1 text-[11px] text-neutral-400 hover:text-neutral-200"
              onClick={() => setGodOpen((o) => !o)}
            >
              <Crown size={11} />{godInfo ? `${godInfo.d} · ${godInfo.c} conflict${godInfo.c === 1 ? "" : "s"}` : "God"}
            </button>
            <button
              type="button"
              aria-label="Agents"
              aria-expanded={rosterOpen}
              onClick={() => { setRosterOpen((o) => !o); setConfirmId(null); setConfirmAll(false); }}
              className="flex items-center gap-1 text-[11px] text-neutral-400 hover:text-neutral-200"
            >
              <Users size={11} /> Agents ({twins.length})
            </button>
            <span className="truncate text-[11px] text-neutral-500">{simStatus}</span>
          </div>
        </div>
        {simNotice && <p className="mt-0.5 text-[11px] text-amber-500">{simNotice}</p>}
        {pulse && (
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-neutral-500">
            {!pulse.watching && <span className="rounded bg-neutral-800 px-1 py-0.5 text-neutral-600">sleeping</span>}
            <span title="conversations in the last 10 min">💬 {pulse.interactions10m}</span>
            <span title="alliances">🤝 {pulse.alliances.length}</span>
            <span title="rivalries">⚔️ {pulse.rivalries.length}</span>
            {pulse.factions.map((f, i) => (
              <span key={i} className="rounded bg-neutral-800/70 px-1 py-0.5 text-neutral-400" title="faction">
                {f.join(" + ")}
              </span>
            ))}
            {pulse.rumors[0] && (
              <span className="truncate text-neutral-600" title={`heard by ${pulse.rumors[0].aware.join(", ")}`}>
                🗞 {pulse.rumors[0].text.slice(0, 40)}{pulse.rumors[0].aware.length ? ` (${pulse.rumors[0].aware.length} know)` : ""}
              </span>
            )}
            <span title="mean affinity">mood {pulse.mood > 0 ? "+" : ""}{pulse.mood}</span>
            {pulse.sim?.configured && (
              <span
                className={`rounded px-1 py-0.5 ${pulse.sim.state === "running" || pulse.sim.state === "waking" ? "bg-sky-900/60 text-sky-300" : "bg-neutral-800/70 text-neutral-500"}`}
                title={`MiroFish epochs: ${pulse.sim.epochsToday} today${pulse.sim.lastEpochAt ? `, last ${Math.max(0, Math.round((Date.now() - new Date(pulse.sim.lastEpochAt).getTime()) / 60000))}m ago` : ""}`}
              >
                📡 {pulse.sim.state}
              </span>
            )}
          </div>
        )}
      </div>
      {rosterOpen && (
        <div className="max-h-40 overflow-y-auto border-b border-neutral-800 px-3 py-2">
          {twins.length === 0 && <p className="text-[11px] text-neutral-500">No agents in the world</p>}
          {twins.map((t) => (
            <div key={t.id} className="group flex items-center justify-between gap-2 py-0.5">
              <button
                type="button"
                onClick={() => onProfile?.(t.id)}
                className="min-w-0 flex-1 truncate text-left text-xs text-neutral-300 hover:text-neutral-100"
              >
                {t.name}
              </button>
              {!demo && (confirmId === t.id ? (
                <span className="flex items-center gap-1 text-[10px] text-neutral-400">
                  Remove?
                  <button
                    type="button"
                    aria-label={`Confirm remove ${t.name}`}
                    onClick={() => { onRemove?.(t.id); setConfirmId(null); }}
                    className="text-red-400 hover:text-red-300"
                  >
                    yes
                  </button>
                  <button
                    type="button"
                    aria-label="Cancel remove"
                    onClick={() => setConfirmId(null)}
                    className="text-neutral-500 hover:text-neutral-300"
                  >
                    no
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  aria-label={`Remove ${t.name}`}
                  onClick={() => setConfirmId(t.id)}
                  className="text-neutral-600 opacity-0 transition-opacity hover:text-red-300 group-hover:opacity-100"
                >
                  <X size={11} />
                </button>
              ))}
            </div>
          ))}
          {!demo && twins.length > 0 && (
            confirmAll ? (
              <span className="mt-1 flex items-center gap-1 text-[10px] text-neutral-400">
                Remove all?
                <button
                  type="button"
                  aria-label="Confirm remove all agents"
                  onClick={() => { onRemoveAll?.(); setConfirmAll(false); }}
                  className="text-red-400 hover:text-red-300"
                >
                  yes
                </button>
                <button
                  type="button"
                  aria-label="Cancel remove all"
                  onClick={() => setConfirmAll(false)}
                  className="text-neutral-500 hover:text-neutral-300"
                >
                  no
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmAll(true)}
                className="mt-1 text-[10px] text-neutral-500 hover:text-red-300"
              >
                Remove all
              </button>
            )
          )}
        </div>
      )}
      <div ref={scroll} className="flex-1 space-y-2.5 overflow-y-auto px-3 py-3">
        {empty && (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <p className="text-xs text-neutral-500">Trigger events, ask what-ifs, or @name a twin.</p>
            {(demo ? DEMO_SUGGESTIONS : SUGGESTIONS).map((s) => (
              <button
                key={s} type="button" onClick={() => send(s)}
                className="w-full rounded-lg border border-neutral-800 px-3 py-2 text-left text-xs text-neutral-300 hover:bg-neutral-800"
              >
                {s}
              </button>
            ))}
          </div>
        )}
        {items.map((item, i) => {
          if (item.kind === "user")
            return (
              <div key={i} className="flex justify-end">
                <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-neutral-800 px-3 py-1.5 text-xs text-neutral-100">
                  {item.text}
                </div>
              </div>
            );
          if (item.kind === "assistant")
            return <p key={i} className="whitespace-pre-wrap text-xs text-neutral-300">{item.text}</p>;
          const { ev } = item;
          if (ev.personaId === "_god")
            return (
              <div key={i} className="rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2">
                <span className="text-[10px] font-medium uppercase tracking-wide text-neutral-500">{ev.name}</span>
                <p className="mt-0.5 text-xs text-neutral-200">{ev.text}</p>
              </div>
            );
          if (ev.kind === "like" || ev.kind === "follow")
            return (
              <p key={i} className="text-[11px] text-neutral-600">
                <span className={cn("font-medium", colorFor(ev.personaId))}>{ev.name}</span>{" "}
                {ev.kind === "like" ? "liked" : "followed"} {ev.text}
              </p>
            );
          return (
            <p key={i} className="text-xs text-neutral-300">
              <span className={cn("mr-1.5 font-semibold", colorFor(ev.personaId))}>{ev.name}</span>
              {ev.text}
            </p>
          );
        })}
        {generating && <p className="animate-pulse text-xs text-neutral-500">Thinking…</p>}
      </div>
      <div className="border-t border-neutral-800 p-2">
        <PromptComposer
          models={[]}
          placeholder="Inject an event, ask 'what if…', or @name…"
          maxLength={2000}
          isGenerating={generating}
          onSend={send}
          onStop={() => abort.current?.abort()}
          className="max-w-none"
        />
      </div>
    </aside>
  );
}
