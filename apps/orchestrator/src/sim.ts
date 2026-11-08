import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Persona, SimEvent } from "@mimk/shared";

export interface SimBackend {
  seedDocument(personas: Persona[]): string;
  events(): AsyncIterable<SimEvent>;
  start?(personas: Persona[], maxRounds: number, scenario?: string): Promise<string>;
  status?(): Promise<string>;
  interview?(personaName: string, prompt: string): Promise<string | undefined>;
}

export class ReplayBackend implements SimBackend {
  constructor(private fixtureEvents: SimEvent[]) {}
  seedDocument(personas: Persona[]): string {
    return personas.map((p) =>
      `## ${p.name}\ntraits: ${p.traits.join(", ")}\nstances: ${p.stances.join("; ")}\n` +
      `speech: ${p.speechStyle}\ninterests: ${p.interests.join(", ")}\nbio: ${p.bio}\n`
    ).join("\n");
  }
  async *events(): AsyncIterable<SimEvent> {
    for (const e of this.fixtureEvents) {
      yield e;
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  async start() { return "replay"; }
  async status() { return "replay fixture"; }
}

// MiroFish: Flask, /api/graph /api/simulation /api/report (verified from source).
// Pipeline: POST /api/graph/ontology/generate (multipart, files[] + simulation_requirement)
//   -> {project_id, ontology} ; POST /api/graph/build {project_id} -> {task_id,graph_id?}
//   poll GET /api/graph/task/<task_id> -> {status}
//   POST /api/simulation/create {project_id} -> {simulation_id}
//   POST /api/simulation/prepare {simulation_id} (async) ; POST /prepare/status {simulation_id}
//   POST /api/simulation/start {simulation_id, max_rounds}
//   GET /api/simulation/<id>/run-status -> {runner_status,current_round,...}
//   GET /api/simulation/<id>/posts|actions -> posts[]/actions[]
//   POST /api/simulation/interview {simulation_id, agent_id, prompt} -> result.response
// Zep is required for graph build; profiles are generated from Zep entities by
// MiroFish itself (no documented way to inject our own profiles), so we map
// sim agents back to our personas by name where possible.
export class MirofishBackend implements SimBackend {
  private simId?: string;
  private projectId?: string;
  private err?: string;
  private nameMap = new Map<string, string>();
  private agentIds = new Map<string, number>();
  private postsSeen = new Set<string>();
  private actionsSeen = new Set<number>();
  private queue: SimEvent[] = [];
  private running = false;

  constructor(private baseUrl: string, private fetchFn: typeof fetch = fetch) {}

  seedDocument(personas: Persona[]): string {
    return (
      personas.map((p) =>
        `## ${p.name}\ntraits: ${p.traits.join(", ")}\nstances: ${p.stances.join("; ")}\n` +
        `speech: ${p.speechStyle}\ninterests: ${p.interests.join(", ")}\n` +
        `relationships: ${p.relationships.join("; ")}\nbio: ${p.bio}\n`
      ).join("\n") +
      `\nScenario: these people hang out in a small online community; a wave of posts, ` +
      `replies, likes and follows unfolds between them.`
    );
  }

  private async j(method: string, path: string, body?: any, form?: FormData) {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: form ? undefined : { "Content-Type": "application/json" },
      body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false)
      throw new Error(`${method} ${path}: ${res.status} ${(data.error ?? "").slice(0, 200)}`);
    return data.data;
  }

  async start(personas: Persona[], maxRounds: number, scenario?: string): Promise<string> {
    if (this.running) return "already running";
    this.running = true;
    this.err = undefined;
    this.simId = undefined;
    this.projectId = undefined;
    this.postsSeen = new Set();
    this.actionsSeen = new Set();
    this.agentIds = new Map();
    this.nameMap = new Map(personas.map((p) => [p.name.toLowerCase(), p.id]));
    void this.drive(personas, maxRounds, scenario)
      .catch((e) => { this.err = String(e?.message ?? e); })
      .finally(() => { this.running = false; });
    return "started";
  }

  private async drive(personas: Persona[], maxRounds: number, scenario?: string) {
    const seed = this.seedDocument(personas) +
      (scenario ? `\n\nHypothetical situation to simulate: ${scenario}` : "");
    const form = new FormData();
    form.append("files", new Blob([seed], { type: "text/markdown" }), "seed.md");
    form.append("simulation_requirement", scenario
      ? `Simulate how these people react to: ${scenario}. They post, reply, like and follow each other.`
      : "Simulate a small online community where these people post, reply, like and follow each other.");
    form.append("project_name", "mimk");
    const onto = await this.j("POST", "/api/graph/ontology/generate", undefined, form);
    this.projectId = onto.project_id;
    const build = await this.j("POST", "/api/graph/build", { project_id: this.projectId });
    for (let i = 0; i < 60; i++) {
      const t = await this.j("GET", `/api/graph/task/${build.task_id}`);
      if (["completed", "success", "finished", "done"].includes(t.status)) break;
      if (["failed", "error"].includes(t.status)) throw new Error(`graph build ${t.status}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
    const proj = await this.j("GET", `/api/graph/project/${this.projectId}`);
    const graphId = proj.graph_id ?? proj.data?.graph_id;
    const sim = await this.j("POST", "/api/simulation/create", {
      project_id: this.projectId, graph_id: graphId, enable_twitter: true, enable_reddit: false,
    });
    this.simId = sim.simulation_id;
    await this.j("POST", "/api/simulation/prepare", { simulation_id: this.simId });
    for (let i = 0; i < 120; i++) {
      const st = await this.j("POST", "/api/simulation/prepare/status", { simulation_id: this.simId });
      if (st.status === "ready" || st.status === "completed" || st.already_prepared) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    await this.j("POST", "/api/simulation/start", { simulation_id: this.simId, max_rounds: maxRounds });
    for (;;) {
      const rs = await this.j("GET", `/api/simulation/${this.simId}/run-status`);
      if (!["running", "starting"].includes(rs.runner_status)) break;
      await new Promise((r) => setTimeout(r, 10000));
    }
  }

  async status(): Promise<string> {
    if (this.err) return `error: ${this.err}`;
    if (!this.simId) return this.running ? "preparing" : "idle";
    try {
      const rs = await this.j("GET", `/api/simulation/${this.simId}/run-status`);
      return `${rs.runner_status} round ${rs.current_round ?? 0}/${rs.total_rounds ?? "?"}`;
    } catch (e: any) {
      return `error: ${e?.message}`;
    }
  }

  async *events(): AsyncIterable<SimEvent> {
    while (true) {
      if (this.simId) {
        try {
          const posts = await this.j("GET", `/api/simulation/${this.simId}/posts?limit=100`);
          for (const p of posts.posts ?? []) {
            const key = `p${p.id ?? p.post_id}`;
            if (this.postsSeen.has(key)) continue;
            this.postsSeen.add(key);
            this.rememberAgent(p);
            const ev: SimEvent = {
              personaId: this.personaFor(p),
              ts: p.created_at ?? new Date().toISOString(),
              kind: "post", text: String(p.content ?? "").slice(0, 200),
            };
            this.queue.push(ev);
          }
          const acts = await this.j("GET", `/api/simulation/${this.simId}/actions?limit=200`);
          for (const a of acts.actions ?? []) {
            const key = a.action_id ?? a.id;
            if (this.actionsSeen.has(key)) continue;
            this.actionsSeen.add(key);
            const kind = a.action_type === "like" ? "like" :
              a.action_type === "follow" ? "follow" :
              ["reply", "comment", "repost", "quote"].includes(a.action_type) ? "reply" : null;
            if (!kind) continue;
            this.queue.push({
              personaId: this.personaFor(a),
              ts: a.created_at ?? new Date().toISOString(),
              kind, text: String(a.content ?? a.action_type).slice(0, 200),
            });
          }
        } catch (e: any) {
          this.err = String(e?.message ?? e);
        }
      }
      while (this.queue.length) yield this.queue.shift()!;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  private rememberAgent(row: any) {
    const name = String(row.agent_name ?? row.user_name ?? row.agent ?? "").toLowerCase();
    const id = Number(row.agent_id ?? row.user_id);
    if (name && Number.isFinite(id)) this.agentIds.set(name, id);
  }

  private personaFor(row: any): string {
    const name = String(row.agent_name ?? row.user_name ?? row.agent ?? "").toLowerCase();
    for (const [n, id] of this.nameMap) if (name.includes(n) || n.includes(name)) return id;
    return name || "unknown";
  }

  async interview(personaName: string, prompt: string): Promise<string | undefined> {
    if (!this.simId) return undefined;
    const agentId = this.agentIds.get(personaName.toLowerCase());
    if (agentId === undefined) return undefined;
    const res = await this.j("POST", "/api/simulation/interview", {
      simulation_id: this.simId, agent_id: agentId, prompt, timeout: 60,
    });
    return res?.result?.response ?? res?.result?.platforms?.twitter?.response;
  }
}

export function loadFixtureDir(dir: string) {
  const out: { subjects: any[]; findings: any[]; dossiers: any[]; personas: Persona[]; events: SimEvent[] } =
    { subjects: [], findings: [], dossiers: [], personas: [], events: [] };
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const data = JSON.parse(readFileSync(join(dir, f), "utf8"));
    if (f === "sim-events.json") out.events = data;
    else if (data.subject) {
      out.subjects.push(data.subject);
      out.findings.push(...(data.findings ?? []));
      if (data.dossier) out.dossiers.push(data.dossier);
      if (data.persona) out.personas.push(data.persona);
    }
  }
  return out;
}
