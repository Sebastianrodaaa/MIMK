import { describe, expect, it } from "vitest";
import { filterSensitive, CreateSubjectSchema, AgentEventSchema } from "../src/index.js";

describe("filterSensitive", () => {
  it("redacts emails", () => {
    expect(filterSensitive("mail me at jane.doe@example.com")).toBe(
      "mail me at [redacted-email]"
    );
  });
  it("redacts phone numbers", () => {
    expect(filterSensitive("call +1 (415) 555-0132 today")).toContain("[redacted-phone]");
  });
  it("redacts street addresses", () => {
    expect(filterSensitive("lives at 1600 Amphitheatre Parkway")).toContain("[redacted-address]");
  });
  it("leaves clean text untouched", () => {
    expect(filterSensitive("works at a university")).toBe("works at a university");
  });
});

describe("CreateSubjectSchema", () => {
  it("rejects bad type", () => {
    expect(
      CreateSubjectSchema.safeParse({ type: "random", name: "x", approvedSources: ["a"] }).success
    ).toBe(false);
  });
  it("rejects empty approvedSources", () => {
    expect(
      CreateSubjectSchema.safeParse({ type: "volunteer", name: "x", approvedSources: [] }).success
    ).toBe(false);
  });
});

describe("AgentEventSchema", () => {
  it("accepts a finding event", () => {
    expect(
      AgentEventSchema.safeParse({ runId: "r1", ts: "t", kind: "finding", data: {} }).success
    ).toBe(true);
  });
});

it("filterSensitive: year ranges kept, real phones redacted", () => {
  for (const keep of ["(2008-2022)", "1991–present", "2019-2024"])
    expect(filterSensitive(`period ${keep}`)).toContain(keep);
  for (const ph of ["+1 (415) 555-0132", "415-555-0132", "+44 20 7946 0958"])
    expect(filterSensitive(`call ${ph}`)).toContain("[redacted-phone]");
  expect(filterSensitive("a@b.com")).toContain("[redacted-email]");
});
