export const ORCH = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL ?? "http://localhost:4000";
export const VNC_HOST = process.env.NEXT_PUBLIC_VNC_HOST ?? "localhost";

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
