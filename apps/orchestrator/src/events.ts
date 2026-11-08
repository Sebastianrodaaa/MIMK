import { AgentEventSchema, type AgentEvent } from "@mimk/shared";

export function parseEventLine(line: string, runId: string): AgentEvent | null {
  line = line.trim();
  if (!line.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(line);
    const res = AgentEventSchema.safeParse({ runId, ...parsed });
    return res.success ? res.data : null;
  } catch {
    return null;
  }
}

// dockerode log streams are multiplexed: each frame is [streamType:1][0:3][size:4][payload].
// Strip headers across arbitrary chunk boundaries; pass through raw (TTY-style) bytes.
export function createLogDemuxer() {
  let pending = Buffer.alloc(0);
  let raw = false;
  return (chunk: Buffer): Buffer => {
    if (raw) return chunk;
    pending = Buffer.concat([pending, chunk]);
    const out: Buffer[] = [];
    while (pending.length >= 8) {
      const type = pending[0];
      const size = pending.readUInt32BE(4);
      if (!(type <= 2 && pending[1] === 0 && pending[2] === 0 && pending[3] === 0)) {
        raw = true;
        const rest = pending;
        pending = Buffer.alloc(0);
        return Buffer.concat([...out, rest]);
      }
      if (pending.length < 8 + size) break;
      out.push(pending.subarray(8, 8 + size));
      pending = pending.subarray(8 + size);
    }
    return Buffer.concat(out);
  };
}
