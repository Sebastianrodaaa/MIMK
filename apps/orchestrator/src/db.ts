import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentRun, Dossier, Persona, Subject } from "@mimk/shared";

export function createDb(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS subjects (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL,
      approvedSources TEXT NOT NULL, consent INTEGER NOT NULL DEFAULT 1,
      consentedAt TEXT NOT NULL DEFAULT '', handles TEXT NOT NULL DEFAULT '[]',
      createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, subjectId TEXT NOT NULL, status TEXT NOT NULL,
      containerId TEXT, vncPort INTEGER, createdAt TEXT NOT NULL,
      backend TEXT NOT NULL DEFAULT 'docker', hSessionId TEXT,
      liveViewUrl TEXT, agentViewUrl TEXT, task TEXT
    );
    CREATE TABLE IF NOT EXISTS dossiers (
      subjectId TEXT PRIMARY KEY, json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS twins (
      id TEXT PRIMARY KEY, subjectId TEXT NOT NULL, json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY, personaId TEXT NOT NULL, title TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
      createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conflicts (
      id TEXT PRIMARY KEY, aId TEXT NOT NULL, bId TEXT NOT NULL, issue TEXT NOT NULL,
      intensity INTEGER NOT NULL DEFAULT 3, status TEXT NOT NULL DEFAULT 'active',
      createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS world_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS deleted_twins (
      id TEXT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS findings (
      runId TEXT NOT NULL, subjectId TEXT NOT NULL, sourceUrl TEXT NOT NULL,
      summary TEXT NOT NULL, ts TEXT NOT NULL,
      UNIQUE(runId, sourceUrl, summary)
    );
    CREATE TABLE IF NOT EXISTS visitors (
      id TEXT PRIMARY KEY, ip TEXT NOT NULL, msgs INTEGER NOT NULL DEFAULT 0,
      twinId TEXT, createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS visitor_subjects (
      visitorId TEXT NOT NULL, subjectId TEXT NOT NULL,
      PRIMARY KEY (visitorId, subjectId)
    );
    CREATE TABLE IF NOT EXISTS relationships (
      aId TEXT NOT NULL, bId TEXT NOT NULL,
      affinity INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'neutral',
      lastAt TEXT, topic TEXT,
      PRIMARY KEY (aId, bId)
    );
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY, personaId TEXT NOT NULL, ts TEXT NOT NULL,
      text TEXT NOT NULL, kind TEXT NOT NULL,
      importance INTEGER NOT NULL DEFAULT 3, source TEXT
    );
    CREATE TABLE IF NOT EXISTS interactions (
      id TEXT PRIMARY KEY, ts TEXT NOT NULL,
      aId TEXT NOT NULL, bId TEXT NOT NULL,
      summary TEXT NOT NULL, intent TEXT NOT NULL, delta INTEGER NOT NULL
    );
  `);
  for (const stmt of [
    "ALTER TABLE subjects ADD COLUMN consent INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE subjects ADD COLUMN consentedAt TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE subjects ADD COLUMN handles TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE runs ADD COLUMN vncPort INTEGER",
    "ALTER TABLE runs ADD COLUMN backend TEXT NOT NULL DEFAULT 'docker'",
    "ALTER TABLE runs ADD COLUMN hSessionId TEXT",
    "ALTER TABLE runs ADD COLUMN liveViewUrl TEXT",
    "ALTER TABLE runs ADD COLUMN agentViewUrl TEXT",
    "ALTER TABLE runs ADD COLUMN task TEXT",
  ]) {
    try { db.exec(stmt); } catch {}
  }
  function deser(r: any): Subject {
    return {
      ...r,
      approvedSources: JSON.parse(r.approvedSources),
      consent: !!r.consent,
      handles: JSON.parse(r.handles ?? "[]"),
    };
  }
  return {
    addSubject(s: Subject) {
      db.prepare(
        "INSERT INTO subjects (id,type,name,approvedSources,consent,consentedAt,handles,createdAt) VALUES (?,?,?,?,?,?,?,?)"
      ).run(s.id, s.type, s.name, JSON.stringify(s.approvedSources),
        s.consent ? 1 : 0, s.consentedAt, JSON.stringify(s.handles ?? []), s.createdAt);
    },
    listSubjects(): Subject[] {
      return (db.prepare("SELECT * FROM subjects").all() as any[]).map(deser);
    },
    getSubject(id: string): Subject | undefined {
      const r = db.prepare("SELECT * FROM subjects WHERE id=?").get(id) as any;
      return r && deser(r);
    },
    addRun(r: AgentRun) {
      db.prepare(
        "INSERT INTO runs (id,subjectId,status,containerId,vncPort,backend,hSessionId,liveViewUrl,agentViewUrl,task,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
      ).run(r.id, r.subjectId, r.status, r.containerId ?? null, r.vncPort ?? null,
        r.backend ?? "docker", r.hSessionId ?? null, r.liveViewUrl ?? null,
        r.agentViewUrl ?? null, r.task ?? null, r.createdAt);
    },
    updateRun(id: string, patch: Partial<AgentRun>) {
      const cur = this.getRun(id);
      if (!cur) return;
      const next = { ...cur, ...patch };
      db.prepare("UPDATE runs SET status=?, containerId=?, vncPort=?, liveViewUrl=? WHERE id=?").run(
        next.status, next.containerId ?? null, next.vncPort ?? null,
        next.liveViewUrl ?? null, id
      );
    },
    getRun(id: string): AgentRun | undefined {
      return db.prepare("SELECT * FROM runs WHERE id=?").get(id) as any;
    },
    listRuns(): AgentRun[] {
      return db.prepare("SELECT * FROM runs ORDER BY createdAt DESC").all() as any;
    },
    saveDossier(d: Dossier) {
      db.prepare("INSERT OR REPLACE INTO dossiers (subjectId,json) VALUES (?,?)").run(
        d.subjectId, JSON.stringify(d));
    },
    getDossier(subjectId: string): Dossier | undefined {
      const r = db.prepare("SELECT json FROM dossiers WHERE subjectId=?").get(subjectId) as any;
      return r && JSON.parse(r.json);
    },
    saveTwin(t: Persona) {
      db.prepare("INSERT OR REPLACE INTO twins (id,subjectId,json) VALUES (?,?,?)").run(
        t.id, t.subjectId, JSON.stringify(t));
      db.prepare("DELETE FROM deleted_twins WHERE id=?").run(t.id);
    },
    seedTwin(t: Persona) {
      if (this.isTwinDeleted(t.id)) return;
      db.prepare("INSERT OR REPLACE INTO twins (id,subjectId,json) VALUES (?,?,?)").run(
        t.id, t.subjectId, JSON.stringify(t));
    },
    deleteTwin(id: string): boolean {
      const row = db.prepare("SELECT subjectId FROM twins WHERE id=?").get(id) as any;
      const existed = !!row;
      db.prepare("INSERT OR IGNORE INTO deleted_twins (id) VALUES (?)").run(id);
      // also tombstone the deterministic persona id derived from the subject —
      // auto-twin checks removal by sha1(subjectId), which differs when a
      // model-built persona overrode its id
      if (row?.subjectId) {
        const sid = createHash("sha1").update(row.subjectId).digest("hex").slice(0, 12);
        db.prepare("INSERT OR IGNORE INTO deleted_twins (id) VALUES (?)").run(sid);
      }
      db.prepare("DELETE FROM twins WHERE id=?").run(id);
      return existed;
    },
    deleteAllTwins(): number {
      const ids = (db.prepare("SELECT id FROM twins").all() as any[]).map((r) => r.id);
      const ins = db.prepare("INSERT OR IGNORE INTO deleted_twins (id) VALUES (?)");
      for (const id of ids) ins.run(id);
      db.prepare("DELETE FROM twins").run();
      return ids.length;
    },
    isTwinDeleted(id: string): boolean {
      return !!db.prepare("SELECT id FROM deleted_twins WHERE id=?").get(id);
    },
    addGoal(g: { id: string; personaId: string; title: string; progress?: number; status?: string; createdAt: string }) {
      db.prepare("INSERT INTO goals (id,personaId,title,progress,status,createdAt) VALUES (?,?,?,?,?,?)")
        .run(g.id, g.personaId, g.title, g.progress ?? 0, g.status ?? "active", g.createdAt);
    },
    listGoals(activeOnly = true): any[] {
      return db.prepare(activeOnly ? "SELECT * FROM goals WHERE status='active'" : "SELECT * FROM goals").all() as any[];
    },
    updateGoal(id: string, patch: { progress?: number; status?: string }) {
      if (patch.progress !== undefined) db.prepare("UPDATE goals SET progress=? WHERE id=?").run(patch.progress, id);
      if (patch.status !== undefined) db.prepare("UPDATE goals SET status=? WHERE id=?").run(patch.status, id);
    },
    addConflict(c: { id: string; aId: string; bId: string; issue: string; intensity?: number; status?: string; createdAt: string }) {
      db.prepare("INSERT INTO conflicts (id,aId,bId,issue,intensity,status,createdAt) VALUES (?,?,?,?,?,?,?)")
        .run(c.id, c.aId, c.bId, c.issue, c.intensity ?? 3, c.status ?? "active", c.createdAt);
    },
    listConflicts(activeOnly = true): any[] {
      return db.prepare(activeOnly ? "SELECT * FROM conflicts WHERE status='active'" : "SELECT * FROM conflicts").all() as any[];
    },
    updateConflict(id: string, patch: { status?: string; intensity?: number }) {
      if (patch.status !== undefined) db.prepare("UPDATE conflicts SET status=? WHERE id=?").run(patch.status, id);
      if (patch.intensity !== undefined) db.prepare("UPDATE conflicts SET intensity=? WHERE id=?").run(patch.intensity, id);
    },
    getWorldState(key: string): string | undefined {
      return (db.prepare("SELECT value FROM world_state WHERE key=?").get(key) as any)?.value;
    },
    setWorldState(key: string, value: string) {
      db.prepare("INSERT INTO world_state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
    },
    getTwin(id: string): Persona | undefined {
      const r = db.prepare("SELECT json FROM twins WHERE id=?").get(id) as any;
      return r && JSON.parse(r.json);
    },
    listTwins(): Persona[] {
      return (db.prepare("SELECT json FROM twins").all() as any[]).map((r) => JSON.parse(r.json));
    },
    addFinding(f: { runId: string; subjectId: string; sourceUrl: string; summary: string; ts: string }) {
      db.prepare(
        "INSERT OR IGNORE INTO findings (runId,subjectId,sourceUrl,summary,ts) VALUES (?,?,?,?,?)"
      ).run(f.runId, f.subjectId, f.sourceUrl, f.summary, f.ts);
    },
    getFindings(subjectId: string) {
      return db.prepare("SELECT * FROM findings WHERE subjectId=?").all(subjectId) as any[];
    },
    getVisitor(id: string) {
      return db.prepare("SELECT * FROM visitors WHERE id=?").get(id) as
        | { id: string; ip: string; msgs: number; twinId: string | null; createdAt: string }
        | undefined;
    },
    touchVisitor(id: string, ip: string) {
      db.prepare(
        "INSERT INTO visitors (id,ip,msgs,twinId,createdAt) VALUES (?,?,0,NULL,?) " +
        "ON CONFLICT(id) DO UPDATE SET ip=excluded.ip"
      ).run(id, ip, new Date().toISOString());
      return this.getVisitor(id)!;
    },
    incVisitorMsgs(id: string) {
      db.prepare("UPDATE visitors SET msgs=msgs+1 WHERE id=?").run(id);
    },
    setVisitorTwin(id: string, twinId: string) {
      db.prepare("UPDATE visitors SET twinId=? WHERE id=?").run(twinId, id);
    },
    countAgentsByIp(ip: string): number {
      return (db.prepare("SELECT COUNT(*) AS n FROM visitors WHERE ip=? AND twinId IS NOT NULL").get(ip) as any).n;
    },
    addVisitorSubject(visitorId: string, subjectId: string) {
      db.prepare("INSERT OR IGNORE INTO visitor_subjects (visitorId,subjectId) VALUES (?,?)").run(visitorId, subjectId);
    },
    listVisitorSubjects(visitorId: string): string[] {
      return (db.prepare("SELECT subjectId FROM visitor_subjects WHERE visitorId=?").all(visitorId) as any[]).map((r) => r.subjectId);
    },
    countTwins(): number {
      return (db.prepare("SELECT COUNT(*) AS n FROM twins").get() as any).n;
    },
    getRelationship(a: string, b: string) {
      const [aId, bId] = [a, b].sort();
      return db.prepare("SELECT * FROM relationships WHERE aId=? AND bId=?").get(aId, bId) as
        | { aId: string; bId: string; affinity: number; status: string; lastAt: string | null; topic: string | null }
        | undefined;
    },
    saveRelationship(a: string, b: string, patch: { affinity: number; status: string; lastAt?: string | null; topic?: string | null }) {
      const [aId, bId] = [a, b].sort();
      const affinity = Math.max(-100, Math.min(100, Math.round(patch.affinity)));
      db.prepare(
        "INSERT INTO relationships (aId,bId,affinity,status,lastAt,topic) VALUES (?,?,?,?,?,?) " +
        "ON CONFLICT(aId,bId) DO UPDATE SET affinity=excluded.affinity,status=excluded.status,lastAt=excluded.lastAt,topic=excluded.topic"
      ).run(aId, bId, affinity, patch.status, patch.lastAt ?? null, patch.topic ?? null);
    },
    listRelationships() {
      return db.prepare("SELECT * FROM relationships").all() as
        { aId: string; bId: string; affinity: number; status: string; lastAt: string | null; topic: string | null }[];
    },
    addMemory(m: { id: string; personaId: string; ts: string; text: string; kind: string; importance?: number; source?: string }) {
      db.prepare(
        "INSERT INTO memories (id,personaId,ts,text,kind,importance,source) VALUES (?,?,?,?,?,?,?)"
      ).run(m.id, m.personaId, m.ts, m.text, m.kind, m.importance ?? 3, m.source ?? null);
      // cap: newest 60 per persona
      db.prepare(
        "DELETE FROM memories WHERE personaId=? AND id NOT IN " +
        "(SELECT id FROM memories WHERE personaId=? ORDER BY ts DESC LIMIT 60)"
      ).run(m.personaId, m.personaId);
    },
    getMemories(personaId: string, kind?: string) {
      return (kind
        ? db.prepare("SELECT * FROM memories WHERE personaId=? AND kind=? ORDER BY ts DESC").all(personaId, kind)
        : db.prepare("SELECT * FROM memories WHERE personaId=? ORDER BY ts DESC").all(personaId)) as
        { id: string; personaId: string; ts: string; text: string; kind: string; importance: number; source: string | null }[];
    },
    addInteraction(i: { id: string; ts: string; aId: string; bId: string; summary: string; intent: string; delta: number }) {
      db.prepare(
        "INSERT INTO interactions (id,ts,aId,bId,summary,intent,delta) VALUES (?,?,?,?,?,?,?)"
      ).run(i.id, i.ts, i.aId, i.bId, i.summary, i.intent, i.delta);
      db.prepare(
        "DELETE FROM interactions WHERE id NOT IN (SELECT id FROM interactions ORDER BY ts DESC LIMIT 300)"
      ).run();
    },
    listInteractions(limit = 100) {
      return db.prepare("SELECT * FROM interactions ORDER BY ts DESC LIMIT ?").all(limit) as
        { id: string; ts: string; aId: string; bId: string; summary: string; intent: string; delta: number }[];
    },
    countInteractions(): number {
      return (db.prepare("SELECT COUNT(*) AS n FROM interactions").get() as any).n;
    },
    countInteractionsFor(personaId: string): number {
      return (db.prepare("SELECT COUNT(*) AS n FROM interactions WHERE aId=? OR bId=?").get(personaId, personaId) as any).n;
    },
    interactionsSince(ts: string): number {
      return (db.prepare("SELECT COUNT(*) AS n FROM interactions WHERE ts>=?").get(ts) as any).n;
    },
  };
}
export type Db = ReturnType<typeof createDb>;
