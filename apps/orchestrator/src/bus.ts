export type FeedEvent = {
  id: number;
  personaId: string;
  name: string;
  ts: string;
  kind: "post" | "reply" | "like" | "follow";
  text: string;
};

export function createBus(limit = 200) {
  const buffer: FeedEvent[] = [];
  const subs = new Set<(e: FeedEvent) => void>();
  let nextId = 1;
  return {
    publish(
      e: { personaId: string; ts?: string; kind: FeedEvent["kind"]; text: string },
      nameOf: (id: string) => string
    ): FeedEvent {
      const ev: FeedEvent = {
        id: nextId++,
        personaId: e.personaId,
        name: nameOf(e.personaId),
        ts: e.ts ?? new Date().toISOString(),
        kind: e.kind,
        text: e.text,
      };
      buffer.push(ev);
      if (buffer.length > limit) buffer.shift();
      for (const cb of subs) cb(ev);
      return ev;
    },
    subscribe(cb: (e: FeedEvent) => void) {
      const history = [...buffer];
      subs.add(cb);
      return { history, close: () => subs.delete(cb) };
    },
  };
}
export type Bus = ReturnType<typeof createBus>;
