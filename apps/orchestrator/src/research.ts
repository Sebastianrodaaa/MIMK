export type ResearchEvent = {
  id: number;
  ts: string;
  runId: string;
  subjectId: string;
  subject: string;
  kind: "start" | "action" | "decision" | "finding" | "summary" | "done" | "failed" | "world";
  text: string;
  sourceUrl?: string;
  instant?: boolean;
  history?: boolean;
};

export function createResearchFeed(limit = 300) {
  const buffer: ResearchEvent[] = [];
  const subs = new Set<(e: ResearchEvent) => void>();
  let nextId = 1;
  return {
    publish(e: Omit<ResearchEvent, "id" | "ts"> & { ts?: string }): ResearchEvent {
      const ev: ResearchEvent = { ...e, id: nextId++, ts: e.ts ?? new Date().toISOString() };
      buffer.push(ev);
      if (buffer.length > limit) buffer.shift();
      for (const cb of subs) cb(ev);
      return ev;
    },
    subscribe(cb: (e: ResearchEvent) => void) {
      const history = [...buffer];
      subs.add(cb);
      return { history, close: () => subs.delete(cb) };
    },
  };
}
export type ResearchFeed = ReturnType<typeof createResearchFeed>;
