import { describe, expect, it, vi } from "vitest";
import express from "express";
import { createDb } from "../src/db.js";
import { parseEventLine } from "../src/events.js";

describe("parseEventLine", () => {
  it("parses a JSON event line", () => {
    const ev = parseEventLine('{"ts":"t","kind":"finding","data":{"x":1}}', "r1");
    expect(ev?.kind).toBe("finding");
    expect(ev?.runId).toBe("r1");
  });
  it("returns null for non-JSON lines", () => {
    expect(parseEventLine("random log noise", "r1")).toBeNull();
  });
  it("returns null for invalid kind", () => {
    expect(parseEventLine('{"ts":"t","kind":"weird","data":{}}', "r1")).toBeNull();
  });
});
