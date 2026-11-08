export type WorldAction =
  | { type: "inject"; text: string }
  | { type: "scenario"; text: string; rounds: number }
  | { type: "ask"; persona: string; text: string }
  | { type: "remove"; persona: string }
  | { type: "simulate"; scenario?: string; rounds: number };

export function worldSystemPrompt(twinNames: string[]): string {
  return (
    `You are the control console for a small simulated community of people ('twins'): ` +
    `${twinNames.length ? twinNames.join(", ") : "none yet"}. Chat concisely. To act on the world ` +
    `append one or more blocks at the very end of your reply: ` +
    `<world_action>{"type":"inject","text":"<event announced to everyone>"}</world_action> for a ` +
    `breaking event or announcement the twins react to; ` +
    `<world_action>{"type":"scenario","text":"<hypothetical situation>","rounds":2}</world_action> ` +
    `for a what-if the twins discuss among themselves for 1-3 rounds; ` +
    `<world_action>{"type":"ask","persona":"<exact twin name>","text":"<question>"}</world_action> ` +
    `to ask one twin directly; ` +
    `<world_action>{"type":"remove","persona":"<exact twin name>"}</world_action> ` +
    `to remove a twin from the world, ONLY when the user explicitly asks to remove/kick/delete that person; ` +
    `<world_action>{"type":"simulate","scenario":"<optional scenario>","rounds":10}</world_action> ` +
    `to launch the full MiroFish simulation (slow, takes minutes) ONLY when the user explicitly ` +
    `asks to run or launch the simulation. Never emit blocks for ordinary conversation.`
  );
}

const ACTION_RE = /<world_action>([\s\S]*?)<\/world_action>/g;
const clamp = (n: unknown, lo: number, hi: number, dflt: number) =>
  Math.min(hi, Math.max(lo, Number.isFinite(Number(n)) ? Number(n) : dflt));

function parseAction(raw: unknown): WorldAction | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const a = raw as any;
  if (a.type === "inject" && typeof a.text === "string" && a.text.trim())
    return { type: "inject", text: a.text.trim() };
  if (a.type === "scenario" && typeof a.text === "string" && a.text.trim())
    return { type: "scenario", text: a.text.trim(), rounds: clamp(a.rounds, 1, 3, 2) };
  if (a.type === "ask" && typeof a.persona === "string" && a.persona.trim() &&
      typeof a.text === "string" && a.text.trim())
    return { type: "ask", persona: a.persona.trim(), text: a.text.trim() };
  if (a.type === "remove" && typeof a.persona === "string" && a.persona.trim())
    return { type: "remove", persona: a.persona.trim() };
  if (a.type === "simulate")
    return {
      type: "simulate",
      scenario: typeof a.scenario === "string" && a.scenario.trim() ? a.scenario.trim() : undefined,
      rounds: clamp(a.rounds, 1, 20, Number(process.env.MIROFISH_MAX_ROUNDS ?? 10)),
    };
  return undefined;
}

export function extractWorldActions(text: string): { reply: string; actions: WorldAction[] } {
  const actions: WorldAction[] = [];
  const reply = text
    .replace(ACTION_RE, (_m, body) => {
      try {
        const a = parseAction(JSON.parse(body));
        if (a && actions.length < 3) actions.push(a);
      } catch {}
      return "";
    })
    .trim();
  return { reply, actions };
}

export function heuristicWorldAction(lastUserMessage: string, twinNames: string[] = []): WorldAction {
  const text = lastUserMessage.trim();
  const rm = text.match(/^\s*(?:remove|kick|delete)\s+(.+?)\s*$/i);
  if (rm && twinNames.some((n) => n.toLowerCase() === rm[1].toLowerCase()))
    return { type: "remove", persona: rm[1] };
  if (/^\s*(what if|imagine|suppose)\b/i.test(text))
    return { type: "scenario", text, rounds: 2 };
  if (/\b(run|start|launch)\b.*\bsimulat/i.test(text))
    return { type: "simulate", rounds: Number(process.env.MIROFISH_MAX_ROUNDS ?? 10) };
  return { type: "inject", text };
}

export function parseMention(
  message: string,
  names: string[]
): { persona: string; text: string } | undefined {
  if (!message.trimStart().startsWith("@")) return undefined;
  const rest = message.trimStart().slice(1);
  const sorted = [...names].sort((a, b) => b.length - a.length);
  for (const name of sorted) {
    if (rest.toLowerCase().startsWith(name.toLowerCase())) {
      const text = rest.slice(name.length).replace(/^[\s,:;-]+/, "").trim();
      return { persona: name, text };
    }
  }
  return undefined;
}
