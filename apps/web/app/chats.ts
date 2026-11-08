"use client";
import { useSyncExternalStore } from "react";

export type InstantFinding = {
  person: string;
  facts: { summary: string; sourceUrl: string; source: string }[];
  handles: Record<string, string>;
  ms: number;
};
export type Msg = { role: "user" | "assistant"; content: string; runIds?: string[]; instant?: InstantFinding[] };
export type Session = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Msg[];
};

const SESSIONS_KEY = "mimk.chats.v1";
const ACTIVE_KEY = "mimk.chat.active";
const LEGACY_KEY = "mimk.chat.v1";
const MAX_SESSIONS = 50;

const listeners = new Set<() => void>();
function emit() {
  for (const l of listeners) l();
}
function subscribe(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === SESSIONS_KEY || e.key === ACTIVE_KEY || e.key === null) cb();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeRaw(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
}

let sessionsCache: { raw: string | null; value: Session[] } = { raw: undefined as any, value: [] };
function parseSessionsRaw(raw: string | null): Session[] {
  if (raw === sessionsCache.raw) return sessionsCache.value;
  let value: Session[] = [];
  try {
    if (raw) value = JSON.parse(raw);
    if (!Array.isArray(value)) value = [];
  } catch {
    value = [];
  }
  sessionsCache = { raw, value };
  return value;
}
function getSessions(): Session[] {
  return parseSessionsRaw(readRaw(SESSIONS_KEY));
}
function setSessions(sessions: Session[]) {
  const capped = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SESSIONS);
  writeRaw(SESSIONS_KEY, JSON.stringify(capped));
  sessionsCache = { raw: readRaw(SESSIONS_KEY), value: capped };
  emit();
}

let activeCache: { raw: string | null; value: string | null } = { raw: undefined as any, value: null };
function parseActiveRaw(raw: string | null): string | null {
  if (raw === activeCache.raw) return activeCache.value;
  const value = raw && raw.length ? raw : null;
  activeCache = { raw, value };
  return value;
}
function getActiveId(): string | null {
  return parseActiveRaw(readRaw(ACTIVE_KEY));
}
function setActiveId(id: string | null) {
  writeRaw(ACTIVE_KEY, id);
  activeCache = { raw: readRaw(ACTIVE_KEY), value: id };
  emit();
}

let migrated = false;
function migrate() {
  if (migrated || typeof window === "undefined") return;
  migrated = true;
  if (readRaw(SESSIONS_KEY) !== null) return;
  try {
    const legacy = JSON.parse(readRaw(LEGACY_KEY) ?? "null");
    if (Array.isArray(legacy) && legacy.length) {
      const firstUser = legacy.find((m: any) => m?.role === "user");
      const now = Date.now();
      const s: Session = {
        id: crypto.randomUUID(),
        title: titleFor(firstUser?.content ?? "Chat"),
        createdAt: now,
        updatedAt: now,
        messages: legacy,
      };
      setSessions([s]);
      setActiveId(s.id);
    }
  } catch {}
}

function titleFor(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 40 ? t.slice(0, 40) + "…" : t || "New chat";
}

export function newChat() {
  setActiveId(null);
}
export function selectChat(id: string) {
  setActiveId(id);
}
export function deleteChat(id: string) {
  setSessions(getSessions().filter((s) => s.id !== id));
  if (getActiveId() === id) setActiveId(null);
}
export function appendMessage(sessionId: string | null, msg: Msg): string {
  const sessions = getSessions();
  const now = Date.now();
  if (sessionId) {
    const s = sessions.find((x) => x.id === sessionId);
    if (s) {
      s.messages = [...s.messages, msg];
      s.updatedAt = now;
      setSessions([...sessions]);
      return sessionId;
    }
  }
  const s: Session = {
    id: crypto.randomUUID(),
    title: titleFor(msg.content),
    createdAt: now,
    updatedAt: now,
    messages: [msg],
  };
  setSessions([s, ...sessions]);
  setActiveId(s.id);
  return s.id;
}

function getSnapshot(): string {
  migrate();
  return `${readRaw(SESSIONS_KEY) ?? ""}|${readRaw(ACTIVE_KEY) ?? ""}`;
}
const getServerSnapshot = () => "";

export function useChats() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const sep = snapshot.lastIndexOf("|");
  const sessions = parseSessionsRaw(sep < 0 ? null : snapshot.slice(0, sep) || null)
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const activeId = parseActiveRaw(sep < 0 ? null : snapshot.slice(sep + 1) || null);
  return { sessions, activeId, active: sessions.find((s) => s.id === activeId) };
}
