export type SpawnTask = string | { task: string; person: string };

export const CHAT_SYSTEM_PROMPT =
  `You are MIMK's assistant. Chat naturally and concisely. If — and only if — the user asks you to do something ` +
  `that needs a computer/browser or explicitly asks for agents, append exactly one block at the very end of your ` +
  `reply: <spawn_agents>{"tasks":["<self-contained task for agent 1>", ...]}</spawn_agents> — one task per agent, ` +
  `max 4, each task fully self-contained (agents share no context). If the user asks for N agents on one goal, ` +
  `write N tasks (split the goal sensibly or give each the same goal). ` +
  `When the user asks you to research / look up / find information about a specific person, emit an object task ` +
  `{"task": "<extra instructions or empty>", "person": "<full name>"} — one object per agent; for N agents on one ` +
  `person emit N objects, optionally splitting angles in "task" (e.g. "focus on professional background"). ` +
  `Use plain string tasks for everything else. Never emit the block for ordinary conversation.`;

const SPAWN_RE = /<spawn_agents>([\s\S]*?)<\/spawn_agents>/;
const AGENTISH = /\b(agents?|spawn|browse|computer|open|search for|go to)\b/i;
const OSINT = /\b(?:research|osint|look up|investigate|find out about)\b\s+(.+)/i;
const STRONG_PERSON =
  /\b(?:research|investigate|look\s+up|osint|find\s+out\s+about|dig\s+into)\s+([A-Z][\w'.-]+(?:\s+[A-Z][\w'.-]+){0,3})/;
const STRONG_N_AGENTS =
  /(?:\b(?:research|search|investigate|look\s+up|find\s+out|browse|dig\s+into)\b[^.?!]{0,80})?\b([1-4])\s+agents?\b/i;

// deterministic fallback for when the model talked instead of spawning:
// only fires on unambiguous research/agent intent, never on conversation.
export function strongIntentSpawn(lastUserMessage: string): SpawnTask[] {
  const p = lastUserMessage.match(STRONG_PERSON);
  if (p) {
    const person = p[1].trim();
    const n = Math.min(4, Math.max(1, Number(lastUserMessage.match(/([1-4])\s*agents?/i)?.[1]) || 1));
    return Array.from({ length: n }, () => ({ task: "", person }));
  }
  const n = lastUserMessage.match(STRONG_N_AGENTS);
  if (n && /\b(?:research|search|investigate|look\s+up|find\s+out|browse|dig\s+into)\b/i.test(lastUserMessage))
    return Array.from({ length: Number(n[1]) }, () => lastUserMessage);
  return [];
}

function parseTask(t: unknown): SpawnTask | undefined {
  if (typeof t === "string") return t.trim() ? t : undefined;
  if (t && typeof t === "object" && typeof (t as any).person === "string" && (t as any).person.trim()) {
    const task = (t as any).task;
    return { person: (t as any).person.trim(), task: typeof task === "string" ? task : "" };
  }
  return undefined;
}

export function extractSpawn(text: string): { reply: string; tasks: SpawnTask[] } {
  const m = text.match(SPAWN_RE);
  if (!m) return { reply: text.trim(), tasks: [] };
  const reply = text.replace(SPAWN_RE, "").trim();
  let tasks: SpawnTask[] = [];
  try {
    const parsed = JSON.parse(m[1]);
    if (Array.isArray(parsed?.tasks))
      tasks = parsed.tasks.map(parseTask).filter((t: SpawnTask | undefined): t is SpawnTask => !!t).slice(0, 4);
  } catch {}
  return { reply, tasks };
}

export function heuristicSpawn(lastUserMessage: string): { reply: string; tasks: SpawnTask[] } {
  const osint = lastUserMessage.match(OSINT);
  if (osint) {
    const person = osint[1].replace(/\b(?:with|using)\s+\d+\s+agents?\b/i, "").replace(/[\s.,;:!?]+$/, "").trim();
    if (person) {
      const n = Math.min(4, Math.max(1, Number(lastUserMessage.match(/(\d)\s*agents?/i)?.[1]) || 1));
      return { reply: "", tasks: Array.from({ length: n }, () => ({ task: "", person })) };
    }
  }
  if (!AGENTISH.test(lastUserMessage))
    return { reply: "I'm offline — set MODEL_API_KEY to chat.", tasks: [] };
  const n = Math.min(4, Math.max(1, Number(lastUserMessage.match(/(\d)\s*agents?/i)?.[1]) || 1));
  return { reply: "", tasks: Array.from({ length: n }, () => lastUserMessage) };
}
