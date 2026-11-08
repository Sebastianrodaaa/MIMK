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
