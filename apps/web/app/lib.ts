import { useEffect, useState } from "react";

export const ORCH = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL ?? "http://localhost:4000";
export const VNC_HOST = process.env.NEXT_PUBLIC_VNC_HOST ?? "localhost";

export type DemoStatus = {
  demo: boolean;
  canChat: boolean;
  hasAgent: boolean;
  twinId?: string;
  twinName?: string;
  chatMsgsLeft?: number;
  worldFull?: boolean;
  ipBlocked?: boolean;
};

export function useDemoStatus(): DemoStatus {
  const [s, setS] = useState<DemoStatus>({ demo: false, canChat: true, hasAgent: false });
  useEffect(() => {
    const load = () =>
      fetch(`${ORCH}/demo/me`, { credentials: "include" })
        .then((r) => r.json())
        .then(setS)
        .catch(() => {});
    load();
    window.addEventListener("mimk:demo-refresh", load);
    return () => window.removeEventListener("mimk:demo-refresh", load);
  }, []);
  return s;
}

export const demoRefresh = () => window.dispatchEvent(new Event("mimk:demo-refresh"));

export const DEMO_ERROR: Record<string, string> = {
  already_created: "You already created an agent — the demo allows one per visitor.",
  ip_cap: "Too many agents were already created from this network.",
  world_full: "The demo world is full right now — try again later.",
  chat_cap: "Chat message limit reached for the hosted demo.",
  read_only: "The hosted demo is read-only.",
};

export type Subject = {
  id: string;
  type: "volunteer" | "public_figure";
  name: string;
  approvedSources: string[];
  consent: true;
  consentedAt: string;
  handles: string[];
  createdAt: string;
};
export type AgentRun = {
  id: string;
  subjectId: string;
  status: "queued" | "running" | "done" | "failed";
  containerId?: string;
  vncPort?: number;
  backend?: "docker" | "h";
  hSessionId?: string;
  liveViewUrl?: string;
  agentViewUrl?: string;
  task?: string | null;
  createdAt: string;
};
export type AgentEvent = {
  runId: string;
  ts: string;
  kind: "log" | "action" | "finding" | "screenshot";
  data: unknown;
};
export type Persona = {
  id: string;
  subjectId: string;
  name: string;
  traits: string[];
  stances: string[];
  speechStyle: string;
  interests: string[];
  relationships: string[];
  avatar: { palette: string[]; accessory: string };
  bio: string;
  kind?: string;
};
export type FeedEvent = {
  id: number;
  personaId: string;
  name: string;
  ts: string;
  kind: "post" | "reply" | "like" | "follow";
  text: string;
  history?: boolean;
};
export type SimEvent = {
  personaId: string;
  ts: string;
  kind: "post" | "reply" | "like" | "follow";
  text: string;
  targetId?: string;
};

export const SOURCE_OPTIONS = [
  "wikipedia", "news", "linkedin", "github", "twitter/x",
  "instagram", "personal-website", "public-records", "archive.org",
];

export function vncUrl(port: number) {
  return `http://${VNC_HOST}:${port}/vnc.html?autoconnect=true&view_only=true&resize=scale`;
}

export type ResearchEvent = {
  id: number; ts: string; runId: string; subjectId: string; subject: string;
  kind: "start" | "action" | "decision" | "finding" | "summary" | "done" | "failed" | "world";
  text: string; sourceUrl?: string; instant?: boolean; history?: boolean;
};
export type Goal = { id: string; personaId: string; title: string; progress: number; status: string; createdAt: string };
export type Conflict = { id: string; aId: string; bId: string; issue: string; intensity: number; status: string; createdAt: string };
export type WorldState = {
  director: { enabled: boolean; intervalSec: number; nextAt: string | null; lastTickAt: string | null };
  goals: Goal[]; conflicts: Conflict[];
  twins: { id: string; name: string; goal?: string }[];
};
