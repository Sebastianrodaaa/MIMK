import { filterSensitive } from "@mimk/shared";
import type { Db } from "./db.js";
import type { SimBackend } from "./sim.js";
import type { Society } from "./society.js";

type EpochSim = SimBackend & {
  waitReady?: (timeoutMs?: number) => Promise<boolean>;
  isActive?: () => boolean;
  waitDone?: (pollMs?: number, timeoutMs?: number) => Promise<{ posts: number; error?: string }>;
};

export type EpochsDeps = {
  sim?: EpochSim;
  db: Db;
  society?: Society;
  post: (personaId: string, kind: "post" | "reply", text: string) => void;
  viewers: () => number;
  now?: () => number;
  ensurePump?: () => void;
  checkMs?: number;
  config?: {
    minGapMin?: number;
    maxPerDay?: number;
    rounds?: number;
    minTwins?: number;
    waitReadyMs?: number;
  };
};

type State = "idle" | "waking" | "running" | "unavailable";

export function createSimEpochs(deps: EpochsDeps) {
  const { db, society, post, viewers } = deps;
  const sim = deps.sim as EpochSim | undefined;
  const now = deps.now ?? (() => Date.now());
  const cfg = {
    minGapMin: deps.config?.minGapMin ?? Number(process.env.SIM_EPOCH_MIN_MIN ?? 30),
    maxPerDay: deps.config?.maxPerDay ?? Number(process.env.SIM_EPOCHS_PER_DAY ?? 6),
    rounds: deps.config?.rounds ?? Number(process.env.SIM_EPOCH_ROUNDS ?? 4),
    minTwins: deps.config?.minTwins ?? 3,
    waitReadyMs: deps.config?.waitReadyMs ?? 120000,
  };
  const checkMs = deps.checkMs ?? 30000;

  const K_LAST = "epoch.lastAt";
  const dayKey = () => `epoch.count.${new Date(now()).toISOString().slice(0, 10)}`;
  const lastEpochAt = () => {
    const v = db.getWorldState(K_LAST);
    return v ? Number(v) : undefined;
  };
  const epochsToday = () => Number(db.getWorldState(dayKey()) ?? 0);

  let state: State = "idle";
  let lastPosts = 0;
  let inFlight = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  function scenarioText(): string {
    const parts: string[] = ["Continuing community dynamics:"];
    const interactions = db.listInteractions(15);
    if (interactions.length) {
      const nameOf = (id: string) => db.getTwin(id)?.name ?? id;
      parts.push("Recent conversations: " + interactions
        .map((i) => `${nameOf(i.aId)}↔${nameOf(i.bId)} (${i.intent}): ${i.summary.slice(0, 60)}`)
        .join("; "));
    }
    const conflicts = db.listConflicts();
    if (conflicts.length)
      parts.push("Active rivalries: " + conflicts.map((c) =>
        `${db.getTwin(c.aId)?.name ?? c.aId} vs ${db.getTwin(c.bId)?.name ?? c.bId} over "${c.issue.slice(0, 80)}"`).join("; "));
    const allies = db.listRelationships().filter((r) => r.status === "ally");
    if (allies.length)
      parts.push("Alliances: " + allies.map((r) =>
        `${db.getTwin(r.aId)?.name ?? r.aId} & ${db.getTwin(r.bId)?.name ?? r.bId}`).join("; "));
    const events = db.listTwins().flatMap((t) => db.getMemories(t.id, "event"))
      .sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 2);
    for (const e of events) parts.push(`Latest event: ${e.text.slice(0, 120)}`);
    return filterSensitive(parts.join("\n")).slice(0, 1500);
  }

  const markAttempt = () => {
    db.setWorldState(K_LAST, String(now()));
    db.setWorldState(dayKey(), String(epochsToday() + 1));
  };

  async function runEpoch(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      const twins = db.listTwins();
      if (sim!.waitReady) {
        state = "waking";
        const ok = await sim!.waitReady(cfg.waitReadyMs);
        if (!ok) {
          state = "unavailable";
          post("_god", "post", "📡 MiroFish unavailable, skipping epoch");
          markAttempt(); // consume minGap so we don't hammer a cold backend
          return;
        }
      }
      state = "running";
      const result = await sim!.start!(twins, cfg.rounds, scenarioText()).catch(() => "error");
      if (result !== "started" && result !== "already running") {
        state = "unavailable";
        post("_god", "post", "📡 MiroFish unavailable, skipping epoch");
        markAttempt();
        return;
      }
      deps.ensurePump?.();
      post("_god", "post", `📡 MiroFish epoch started (${twins.length} agents)`);
      const done = sim!.waitDone ? await sim!.waitDone() : { posts: 0 };
      lastPosts = done.posts;
      markAttempt();
      post("_god", "post", `📡 MiroFish epoch finished (${lastPosts} posts)`);
      state = "idle";
    } catch {
      state = "unavailable";
      markAttempt();
    } finally {
      inFlight = false;
    }
  }

  function check() {
    try {
      if (!sim?.start || inFlight) return;
      if (viewers() <= 0) return;
      if (db.countTwins() < cfg.minTwins) return;
      const last = lastEpochAt();
      if (last !== undefined && now() - last < cfg.minGapMin * 60000) return;
      if (epochsToday() >= cfg.maxPerDay) return;
      void runEpoch();
    } catch {}
  }

  return {
    start() {
      if (!timer) {
        timer = setInterval(check, checkMs);
        timer.unref?.();
        check();
      }
    },
    stop() { if (timer) clearInterval(timer); timer = undefined; },
    /** Feed a MiroFish-sourced event back into society state. */
    ingestEvent(e: { personaId: string; kind: string; text: string; targetId?: string }) {
      try {
        if (!society) return;
        const twins = db.listTwins();
        const actor = twins.find((t) => t.id === e.personaId);
        if (!actor) return;
        if (e.kind === "post") {
          const others = twins.filter((t) => t.id !== actor.id);
          for (const t of others.slice(0, 2))
            society.recordRumor(t.id, e.text.slice(0, 200), "town square");
        }
        const target = e.targetId && twins.find((t) => t.id === e.targetId);
        if (target) {
          const delta = e.kind === "like" ? 2 : e.kind === "follow" ? 5 : e.kind === "reply" ? 1 : 0;
          if (delta) society.nudgeAffinity(actor.id, target.id, delta);
        }
      } catch {}
    },
    state() {
      return {
        configured: !!sim,
        state: sim ? state : "unavailable" as State,
        lastEpochAt: lastEpochAt() ? new Date(lastEpochAt()!).toISOString() : null,
        epochsToday: epochsToday(),
        lastPosts,
      };
    },
    // exposed for tests
    runEpoch, check, scenarioText,
  };
}
export type SimEpochs = ReturnType<typeof createSimEpochs>;
