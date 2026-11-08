"use client";
import { useEffect, useRef, useState } from "react";
import { ORCH, AgentRun, Persona, useDemoStatus, demoRefresh, DEMO_ERROR } from "./lib";
import { useChats, appendMessage, type Msg } from "./chats";
import PromptComposer from "@/components/ui/prompt-composer";
import AgentGrid from "./components/AgentGrid";
import InstantFindings from "./components/InstantFindings";
import { Sparkles } from "lucide-react";

const inflight = new Map<string, AbortController>();

export default function ChatPage() {
  const { activeId, active } = useChats();
  const messages = active?.messages ?? [];
  const [inflightIds, setInflightIds] = useState<Set<string>>(new Set());
  const scroll = useRef<HTMLDivElement>(null);
  const generating = !!activeId && inflightIds.has(activeId);
  const prevSid = useRef<string | null | undefined>(undefined);
  const demo = useDemoStatus();
  const [twin, setTwin] = useState<Persona | null>(null);
  const [twinErr, setTwinErr] = useState("");
  const [twinPending, setTwinPending] = useState(false);

  useEffect(() => {
    if (!scroll.current) return;
    const instant = prevSid.current !== activeId;
    prevSid.current = activeId;
    scroll.current.scrollTo({ top: scroll.current.scrollHeight, behavior: instant ? "auto" : "smooth" });
  }, [messages.length, activeId]);

  async function send(text: string) {
    let sid = activeId ?? null;
    const userMsg: Msg = { role: "user", content: text };
    sid = appendMessage(sid, userMsg);
    const history = [...messages, userMsg].map(({ role, content }) => ({ role, content })).slice(-20);
    const ac = new AbortController();
    inflight.set(sid, ac);
    setInflightIds(new Set(inflight.keys()));
    try {
      const res = await fetch(`${ORCH}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ messages: history }),
        signal: ac.signal,
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        if (j?.code && DEMO_ERROR[j.code]) {
          appendMessage(sid, { role: "assistant", content: DEMO_ERROR[j.code] });
          demoRefresh();
          return;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      const data: { reply: string; runs: AgentRun[] } = await res.json();
      appendMessage(sid, { role: "assistant", content: data.reply, runIds: data.runs?.map((r) => r.id), instant: (data as any).instant });
      demoRefresh();
    } catch (e: any) {
      if (e?.name !== "AbortError")
        appendMessage(sid, { role: "assistant", content: `Error: ${e?.message ?? e}` });
    } finally {
      inflight.delete(sid);
      setInflightIds(new Set(inflight.keys()));
    }
  }

  async function turnIntoAgent() {
    setTwinPending(true);
    setTwinErr("");
    try {
      const res = await fetch(`${ORCH}/twins/from-chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          messages: messages.map(({ role, content }) => ({ role, content })).slice(-20),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(DEMO_ERROR[j?.code] ?? j?.error ?? `HTTP ${res.status}`);
      setTwin(j);
      demoRefresh();
    } catch (e: any) {
      setTwinErr(e?.message ?? String(e));
    } finally {
      setTwinPending(false);
    }
  }

  const empty = messages.length === 0;
  const hasAssistant = messages.some((m) => m.role === "assistant");
  const blocked = demo.demo && !demo.canChat;
  const composer = blocked ? (
    <div className="mx-auto max-w-2xl rounded-2xl border border-neutral-800 bg-neutral-900/60 px-4 py-3 text-sm text-neutral-400">
      {demo.hasAgent ? (
        <>
          One agent per visitor in this demo —{" "}
          <a href={`/world?focus=${demo.twinId ?? ""}`} className="text-sky-300 hover:underline">
            {demo.twinName ?? "your agent"}
          </a>{" "}
          is already in the <a href="/world" className="text-sky-300 hover:underline">world</a>.
        </>
      ) : (
        "Chat limit reached for this demo — visit the world to see the agents."
      )}
    </div>
  ) : (
    <PromptComposer
      models={[]}
      placeholder="Ask anything — research a person, company or idea…"
      maxLength={2000}
      isGenerating={generating}
      onSend={send}
      onStop={() => activeId && inflight.get(activeId)?.abort()}
      className="max-w-2xl mx-auto"
    />
  );

  const agentCard = twin ? (
    <div className="mx-auto max-w-2xl rounded-2xl border border-emerald-900/60 bg-emerald-950/30 px-4 py-3">
      <p className="text-sm text-emerald-200">
        <span className="font-medium">{twin.name}</span> joined the world.
      </p>
      <a
        href={`/world?focus=${twin.id}`}
        className="mt-1 inline-block text-xs text-sky-300 hover:underline"
      >
        Watch them in the pixel world →
      </a>
    </div>
  ) : (
    <div className="mx-auto max-w-2xl">
      {twinErr && <p className="mb-1 text-xs text-red-400">{twinErr}</p>}
      <button
        type="button"
        onClick={turnIntoAgent}
        disabled={twinPending || !hasAssistant || demo.hasAgent}
        className="flex items-center gap-2 rounded-2xl border border-neutral-800 bg-neutral-900/60 px-4 py-2.5 text-sm text-neutral-300 transition-colors hover:bg-neutral-800 disabled:opacity-40"
      >
        <Sparkles size={14} className="text-amber-300" />
        {twinPending ? "Creating your agent…" : "Turn this chat into an agent"}
      </button>
    </div>
  );
  const showAgentCard = hasAssistant && !demo.hasAgent && !blocked;

  if (empty)
    return (
      <div className="flex h-[calc(100vh-3rem)] flex-col items-center justify-center gap-8">
        <h1 className="text-2xl font-medium tracking-tight text-neutral-200">What should we work on?</h1>
        <div className="w-full px-4">{composer}</div>
      </div>
    );

  return (
    <div className="flex h-[calc(100vh-3rem)] flex-col">
      <div ref={scroll} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-6 px-4 py-6">
          {messages.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-neutral-800 px-4 py-2 text-sm text-neutral-100">
                  {m.content}
                </div>
              </div>
            ) : (
              <div key={i} className="text-sm text-neutral-200">
                <p className="whitespace-pre-wrap">{m.content}</p>
                {m.instant && <InstantFindings instant={m.instant} />}
                {m.runIds && m.runIds.length > 0 && <AgentGrid runIds={m.runIds} />}
              </div>
            )
          )}
          {generating && <p className="animate-pulse text-sm text-neutral-500">Thinking…</p>}
        </div>
      </div>
      {(showAgentCard || twin) && <div className="px-4 pb-2">{agentCard}</div>}
      <div className="px-4 pb-2">{composer}</div>
    </div>
  );
}
