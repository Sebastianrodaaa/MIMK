import { createHash } from "node:crypto";
import {
  filterSensitive,
  type Dossier,
  type Finding,
  type Persona,
} from "@mimk/shared";

export type ChatFn = (messages: { role: string; content: string }[]) => Promise<string>;

export function buildDossier(subjectId: string, findings: Finding[]): Dossier {
  const seen = new Set<string>();
  const facts = [];
  for (const f of findings) {
    const claim = filterSensitive(f.summary).trim();
    const key = claim.toLowerCase().replace(/\W+/g, " ").slice(0, 80);
    if (!claim || seen.has(key)) continue;
    seen.add(key);
    facts.push({
      claim,
      sourceUrl: f.sourceUrl,
      confidence: f.sourceUrl ? 0.8 : 0.5,
    });
  }
  const summary = filterSensitive(
    facts.slice(0, 8).map((f) => f.claim).join(" ")
  ).slice(0, 600);
  return { subjectId, facts, summary };
}

const ACCESSORIES = ["none", "hat", "glasses", "scarf", "headphones"] as const;
const PALETTES = [
  ["#e0ac69", "#3b82f6", "#1e293b"],
  ["#f1c27d", "#ef4444", "#334155"],
  ["#8d5524", "#10b981", "#0f172a"],
  ["#ffdbac", "#8b5cf6", "#1f2937"],
  ["#c68642", "#06b6d4", "#27272a"],
];

export function fixturePersona(subjectId: string, name: string, dossier: Dossier): Persona {
  const h = createHash("sha1").update(name).digest();
  const interests = [...new Set(
    dossier.facts
      .flatMap((f) => f.claim.split(/[^A-Za-z ]+/))
      .map((w) => w.trim())
      .filter((w) => w.length > 7)
      .slice(0, 4)
  )];
  return {
    id: createHash("sha1").update(subjectId).digest("hex").slice(0, 12),
    subjectId,
    name,
    traits: ["curious", "opinionated"],
    stances: dossier.facts.slice(0, 3).map((f) => f.claim.slice(0, 120)),
    speechStyle: "casual, a bit dry, uses short sentences",
    interests: interests.length ? interests : ["technology", "community"],
    relationships: [],
    avatar: {
      palette: PALETTES[h[0] % PALETTES.length],
      accessory: ACCESSORIES[h[1] % ACCESSORIES.length],
    },
    bio: dossier.summary.slice(0, 200) || `${name}, a participant in the demo.`,
  };
}

export async function buildPersona(
  dossier: Dossier,
  name: string,
  chat?: ChatFn,
  opts?: { kind?: string; conversation?: string }
): Promise<Persona> {
  if (!chat) {
    const p = fixturePersona(dossier.subjectId, name, dossier);
    return opts?.kind ? { ...p, kind: opts.kind } : p;
  }
  const kindNote =
    opts?.kind && opts.kind !== "person"
      ? ` The entity is a ${opts.kind} (not a person): write the persona as a character that embodies and represents it — an employee, spokesperson or mascot voice speaking for it.`
      : "";
  const reply = await chat([
    {
      role: "system",
      content:
        "Build a fictional twin persona for a pixel-world simulation from this research dossier. " +
        "Reply with raw JSON only: {name, traits[], stances[], speechStyle, interests[], relationships[], avatar:{palette:[#rrggbb,...], accessory:'none|hat|glasses|scarf|headphones'}, bio}. Keep it respectful, based only on the dossier." +
        kindNote,
    },
    {
      role: "user",
      content: JSON.stringify({
        name, dossier,
        ...(opts?.conversation ? { conversation: opts.conversation.slice(0, 4000) } : {}),
      }),
    },
  ]);
  const withKind = (p: Persona): Persona => (opts?.kind ? { ...p, kind: opts.kind } : p);
  const m = reply.match(/\{[\s\S]*\}/);
  if (!m) return withKind(fixturePersona(dossier.subjectId, name, dossier));
  try {
    const parsed = JSON.parse(m[0]);
    const base = fixturePersona(dossier.subjectId, name, dossier);
    return { ...base, ...parsed, id: base.id, name, subjectId: dossier.subjectId, kind: opts?.kind };
  } catch {
    return withKind(fixturePersona(dossier.subjectId, name, dossier));
  }
}
