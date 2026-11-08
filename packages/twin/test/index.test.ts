import { describe, expect, it } from "vitest";
import { PersonaSchema, type Finding } from "@mimk/shared";
import { buildDossier, fixturePersona } from "../src/index.js";

const findings: Finding[] = [
  { runId: "r1", sourceUrl: "https://x/1", summary: "Runs a hackerspace in Berlin", ts: "t" },
  { runId: "r1", sourceUrl: "https://x/1", summary: "Runs a hackerspace in Berlin", ts: "t" },
  { runId: "r2", sourceUrl: "https://x/2", summary: "Email jane@example.com likes synths", ts: "t" },
  { runId: "r2", sourceUrl: "", summary: "Spoke at a conference", ts: "t" },
];

describe("buildDossier", () => {
  const d = buildDossier("s1", findings);
  it("dedupes identical claims", () => {
    expect(d.facts).toHaveLength(3);
  });
  it("applies filterSensitive again", () => {
    expect(JSON.stringify(d)).toContain("[redacted-email]");
    expect(JSON.stringify(d)).not.toContain("jane@example.com");
  });
  it("lower confidence for url-less facts", () => {
    expect(d.facts.find((f) => !f.sourceUrl)?.confidence).toBe(0.5);
  });
});

describe("fixturePersona", () => {
  it("produces a schema-valid persona deterministically", () => {
    const d = buildDossier("s1", findings);
    const p1 = fixturePersona("s1", "Ada Voss", d);
    const p2 = fixturePersona("s1", "Ada Voss", d);
    expect(PersonaSchema.safeParse(p1).success).toBe(true);
    expect(p1).toEqual(p2);
  });
});

describe("buildPersona", () => {
  it("passes kind/conversation through and keeps id/name pinned", async () => {
    const { buildPersona } = await import("../src/index.js");
    const d = buildDossier("s1", findings);
    let seen: { role: string; content: string }[] = [];
    const chat = async (msgs: { role: string; content: string }[]) => {
      seen = msgs;
      return '{"name":"Wrong Name","traits":["loud"],"bio":"A mascot."}';
    };
    const p = await buildPersona(d, "Acme Corp", chat, { kind: "company", conversation: "user: tell me about Acme" });
    expect(p.id).toBe(fixturePersona("s1", "Acme Corp", d).id);
    expect(p.name).toBe("Acme Corp");
    expect(p.subjectId).toBe("s1");
    expect(p.kind).toBe("company");
    expect(p.traits).toEqual(["loud"]);
    expect(seen[0].content).toContain("company");
    expect(seen[0].content).toContain("mascot");
    expect(seen[1].content).toContain("tell me about Acme");
    expect(PersonaSchema.safeParse(p).success).toBe(true);
  });

  it("fixture path works with no chat fn and sets kind", async () => {
    const { buildPersona } = await import("../src/index.js");
    const d = buildDossier("s1", findings);
    const p = await buildPersona(d, "An Idea", undefined, { kind: "idea" });
    expect(p.name).toBe("An Idea");
    expect(p.kind).toBe("idea");
  });
});
