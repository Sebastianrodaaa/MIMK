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
  };
}
export type Db = ReturnType<typeof createDb>;
