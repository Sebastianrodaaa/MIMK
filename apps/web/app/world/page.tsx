"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ORCH, Persona } from "../lib";
import WorldChat from "../components/WorldChat";

const OFFICE_URL = process.env.NEXT_PUBLIC_OFFICE_URL || "http://127.0.0.1:3200";

export default function World() {
  const frame = useRef<HTMLIFrameElement>(null);
  const known = useRef(new Map<string, number>());
  const nextId = useRef(1);
  const toolSeq = useRef(0);
  const [ready, setReady] = useState(false);
  const [personas, setPersonas] = useState<Persona[]>([]);

  const post = (msg: Record<string, unknown>) => frame.current?.contentWindow?.postMessage(msg, "*");
  const api = {
    addPersona(p: Persona) {
      let id = known.current.get(p.id);
      if (!id) { id = nextId.current++; known.current.set(p.id, id); }
      post({ type: "agentCreated", id, directoryName: p.name, palette: (id - 1) % 6, hueShift: id > 6 ? 45 * (id % 8) : 0 });
    },
    removePersona(pid: string) {
      const id = known.current.get(pid);
      if (!id) return;
      post({ type: "agentClosed", id });
      known.current.delete(pid);
    },
    say(pid: string, text: string) {
      const id = known.current.get(pid);
      if (!id) return;
      const toolId = `say-${++toolSeq.current}`;
      post({ type: "agentToolStart", id, toolId, toolName: "Say", status: `Saying: ${text.slice(0, 60)}` });
      setTimeout(() => post({ type: "agentToolDone", id, toolId }), 3500);
    },
  };
  const sayRef = useRef(api.say);
  sayRef.current = api.say;
  const onSpeak = useCallback((pid: string, text: string) => sayRef.current(pid, text), []);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => { if (e.data?.type === "mimkOfficeReady") setReady(true); };
    window.addEventListener("message", onMsg);
    const t = setTimeout(() => setReady(true), 4000);
    return () => { window.removeEventListener("message", onMsg); clearTimeout(t); };
  }, []);

  const sync = useCallback(async () => {
    const twins: Persona[] = await fetch(`${ORCH}/twins`).then((r) => r.json()).catch(() => []);
    setPersonas(twins);
    const present = new Set(twins.map((t) => t.id));
    for (const pid of [...known.current.keys()])
      if (!present.has(pid)) api.removePersona(pid);
    twins.forEach((p, i) => setTimeout(() => api.addPersona(p), 300 * i));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const syncRef = useRef(sync);
  syncRef.current = sync;
  const onRemove = useCallback(
    async (id: string) => { await fetch(`${ORCH}/twins/${id}`, { method: "DELETE" }).catch(() => {}); syncRef.current(); },
    []
  );
  const onRemoveAll = useCallback(
    async () => { await fetch(`${ORCH}/twins`, { method: "DELETE" }).catch(() => {}); syncRef.current(); },
    []
  );

  useEffect(() => {
    if (!ready) return;
    sync();
    const poll = setInterval(sync, 5000);
    return () => clearInterval(poll);
  }, [ready, sync]);

  return (
    <main className="flex gap-4 h-[calc(100vh-3rem)]">
      <iframe
        ref={frame}
        src={`${OFFICE_URL}?embed=1`}
        title="Pixel office"
        className="flex-1 min-w-0 h-full rounded-lg border border-neutral-800 bg-black"
      />
      <WorldChat onSpeak={onSpeak} twins={personas} onRemove={onRemove} onRemoveAll={onRemoveAll} />
    </main>
  );
}
