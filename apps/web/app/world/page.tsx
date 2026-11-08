"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ORCH, Persona, useDemoStatus } from "../lib";
import WorldChat from "../components/WorldChat";
import ProfileDrawer from "../components/ProfileDrawer";


const OFFICE_URL = process.env.NEXT_PUBLIC_OFFICE_URL || "http://127.0.0.1:3200";

// Stable numeric id per persona, independent of add order or page remounts.
// Offset high so it can't collide with real sequential agent ids in the office.
function officeIdFor(pid: string): number {
  let h = 0;
  for (const c of pid) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 100000 + (h % 900000);
}

export default function World() {
  const frame = useRef<HTMLIFrameElement>(null);
  const known = useRef(new Set<string>());
  const toolSeq = useRef(0);
  const [ready, setReady] = useState(false);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [profileId, setProfileId] = useState<string | null>(null);
  const demo = useDemoStatus();
  const personasRef = useRef<Persona[]>([]);
  personasRef.current = personas;

  const post = (msg: Record<string, unknown>) => frame.current?.contentWindow?.postMessage(msg, "*");
  const api = {
    addPersona(p: Persona) {
      const id = officeIdFor(p.id);
      known.current.add(p.id);
      post({ type: "agentCreated", id, directoryName: p.name, palette: id % 6, hueShift: 45 * (id % 8) });
    },
    removePersona(pid: string) {
      post({ type: "agentClosed", id: officeIdFor(pid) });
      known.current.delete(pid);
    },
    say(pid: string, text: string) {
      if (!known.current.has(pid)) return;
      post({ type: "mimkSpeech", id: officeIdFor(pid), text });
    },
  };
  const onFollow = (personaId: string | null) => {
    post({ type: "mimkFollowAgent", id: personaId ? officeIdFor(personaId) : null });
  };
  const followRef = useRef(onFollow);
  followRef.current = onFollow;
  const openProfile = useCallback((pid: string | null) => {
    setProfileId(pid);
    if (pid) followRef.current(pid);
  }, []);
  const sayRef = useRef(api.say);
  sayRef.current = api.say;
  const onSpeak = useCallback((pid: string, text: string) => sayRef.current(pid, text), []);
  // walking pairs together: at most one mimkMeet per pair per 6s
  const meetAt = useRef(new Map<string, number>());
  const onMeet = useCallback((a: string, b: string) => {
    const key = [a, b].sort().join("|");
    const last = meetAt.current.get(key) ?? 0;
    if (Date.now() - last < 6000) return;
    meetAt.current.set(key, Date.now());
    post({ type: "mimkMeet", a: officeIdFor(a), b: officeIdFor(b) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const deleteTwin = (pid: string | undefined) => {
      if (!pid) return;
      void fetch(`${ORCH}/twins/${pid}`, { method: "DELETE", credentials: "include" })
        .then(() => syncRef.current())
        .catch(() => {});
    };
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === "mimkOfficeReady") {
        setReady(true);
        // The office just booted — wipe any leftover characters (remounted id
        // mappings, stale sessions) so the roster is the only source of truth.
        post({ type: "mimkClearAgents" });
      }
      if (e.data?.type === "mimkAgentSelect") {
        const pid = e.data.id == null
          ? null
          : personasRef.current.find((p) => officeIdFor(p.id) === e.data.id)?.id ?? null;
        openProfile(pid);
      }
      if (e.data?.type === "mimkAgentClose") {
        let pid = [...known.current].find((p) => officeIdFor(p) === e.data.id);
        if (pid) return deleteTwin(pid);
        // Id didn't map — fall back to matching the character's display name.
        const name = e.data.name;
        if (typeof name === "string" && name)
          void fetch(`${ORCH}/twins`)
            .then((r) => r.json())
            .then((ts: Persona[]) => deleteTwin(ts.find((t) => t.name === name)?.id))
            .catch(() => {});
      }
    };
    window.addEventListener("message", onMsg);
    const t = setTimeout(() => setReady(true), 4000);
    // Deep link: /world?focus=<twinId> opens that agent's profile + camera follow
    const focus = new URLSearchParams(window.location.search).get("focus");
    if (focus) openProfile(focus);
    return () => { window.removeEventListener("message", onMsg); clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    async (id: string) => { await fetch(`${ORCH}/twins/${id}`, { method: "DELETE", credentials: "include" }).catch(() => {}); syncRef.current(); },
    []
  );
  const onRemoveAll = useCallback(
    async () => { await fetch(`${ORCH}/twins`, { method: "DELETE", credentials: "include" }).catch(() => {}); syncRef.current(); },
    []
  );

  useEffect(() => {
    if (!ready) return;
    // Clean slate on mount: if the iframe survived a page remount it may hold
    // characters whose ids this session can't map — wipe them before re-adding.
    post({ type: "mimkClearAgents" });
    known.current.clear();
    sync();
    const poll = setInterval(sync, 5000);
    return () => clearInterval(poll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, sync]);

  return (
    <main className="relative flex gap-4 h-[calc(100vh-3rem)]">
      <iframe
        ref={frame}
        src={`${OFFICE_URL}?embed=1`}
        title="Pixel office"
        className="flex-1 min-w-0 h-full rounded-lg border border-neutral-800 bg-black"
      />
      <div className="flex w-96 shrink-0 flex-col gap-2">
        <WorldChat onSpeak={onSpeak} onMeet={onMeet} twins={personas} onRemove={onRemove} onRemoveAll={onRemoveAll} onFollow={onFollow} onProfile={openProfile} demo={demo.demo} />
      </div>
      {profileId && <ProfileDrawer twinId={profileId} onClose={() => setProfileId(null)} onOpen={openProfile} />}
    </main>
  );
}
