"use client";
import { useEffect, useRef, useState } from "react";
import { ORCH, FeedEvent, Persona } from "../lib";
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
  "Run the simulation",
  "What if the office Wi-Fi goes down for a week?",
  "Announce: free pizza in the kitchen",
];

export default function WorldChat({ onSpeak, twins = [], onRemove, onRemoveAll }: {
  onSpeak: (personaId: string, text: string) => void;
  twins?: Persona[];
  onRemove?: (id: string) => void;
  onRemoveAll?: () => void;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [generating, setGenerating] = useState(false);
  const [simStatus, setSimStatus] = useState("");
  const [simNotice, setSimNotice] = useState("");
  const [rosterOpen, setRosterOpen] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const seen = useRef(new Set<number>());
  const abort = useRef<AbortController | undefined>(undefined);
  const scroll = useRef<HTMLDivElement>(null);
  const speakRef = useRef(onSpeak);
  speakRef.current = onSpeak;

  useEffect(() => {
    const es = new EventSource(`${ORCH}/world/feed`);
    es.onmessage = (m) => {
      try {
        const ev = JSON.parse(m.data) as FeedEvent;
        if (seen.current.has(ev.id)) return;
        seen.current.add(ev.id);
        setItems((prev) => [...prev, { kind: "event", ev }]);
        if (!ev.history && ev.personaId !== "_god") speakRef.current(ev.personaId, ev.text);
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
    <aside className="flex h-full w-96 shrink-0 flex-col rounded-lg border border-neutral-800 bg-neutral-900/50">
      <div className="border-b border-neutral-800 px-3 py-2">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-sm font-medium">World chat</h3>
          <div className="flex items-center gap-2">
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
      </div>
      {rosterOpen && (
        <div className="max-h-40 overflow-y-auto border-b border-neutral-800 px-3 py-2">
          {twins.length === 0 && <p className="text-[11px] text-neutral-500">No agents in the world</p>}
          {twins.map((t) => (
            <div key={t.id} className="group flex items-center justify-between gap-2 py-0.5">
              <span className="truncate text-xs text-neutral-300">{t.name}</span>
              {confirmId === t.id ? (
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
              )}
            </div>
          ))}
          {twins.length > 0 && (
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
            {SUGGESTIONS.map((s) => (
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
