"use client";
import { useEffect, useRef, useState } from "react";
import { ORCH, AgentRun } from "./lib";
import { useChats, appendMessage, type Msg } from "./chats";
import PromptComposer from "@/components/ui/prompt-composer";
import AgentGrid from "./components/AgentGrid";
import InstantFindings from "./components/InstantFindings";

const inflight = new Map<string, AbortController>();

export default function ChatPage() {
  const { activeId, active } = useChats();
  const messages = active?.messages ?? [];
  const [inflightIds, setInflightIds] = useState<Set<string>>(new Set());
  const scroll = useRef<HTMLDivElement>(null);
  const generating = !!activeId && inflightIds.has(activeId);
  const prevSid = useRef<string | null | undefined>(undefined);

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
        body: JSON.stringify({ messages: history }),
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: { reply: string; runs: AgentRun[] } = await res.json();
      appendMessage(sid, { role: "assistant", content: data.reply, runIds: data.runs?.map((r) => r.id), instant: (data as any).instant });
    } catch (e: any) {
      if (e?.name !== "AbortError")
        appendMessage(sid, { role: "assistant", content: `Error: ${e?.message ?? e}` });
    } finally {
      inflight.delete(sid);
      setInflightIds(new Set(inflight.keys()));
    }
  }

  const empty = messages.length === 0;
  const composer = (
    <PromptComposer
      models={[]}
      placeholder="Ask anything, or ask for agents…"
      maxLength={2000}
      isGenerating={generating}
      onSend={send}
      onStop={() => activeId && inflight.get(activeId)?.abort()}
      className="max-w-2xl mx-auto"
    />
  );

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
      <div className="px-4 pb-2">{composer}</div>
    </div>
  );
}
