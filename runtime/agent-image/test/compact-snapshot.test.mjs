import assert from "node:assert";
import { readFileSync } from "node:fs";
import { compactSnapshot } from "../compact.js";

const raw = readFileSync(new URL("./fixtures/google-consent-snapshot.json", import.meta.url), "utf8");
const out = compactSnapshot(raw);
assert(out.length < 10000, `too long: ${out.length}`);
assert(out.includes("Avant d'accéder"), "missing dialog text");
assert(/@s\w+:e\d+/.test(out), "no page link ref");
assert(!/\| menuitem \|/.test(out), "menuitem leaked");
const firstRef = out.match(/@s\w+:e\d+/)?.[0];
const learnIdx = out.indexOf("Learn more");
assert(!(learnIdx > -1 && out.indexOf(firstRef) >= learnIdx && out.slice(0, learnIdx).includes("Learn more")), "UI ref first");
assert(out.includes("SCROLL-TARGET"), "no scroll target");
assert(out.includes("(offscreen)"), "no offscreen marker");
assert.doesNotThrow(() => compactSnapshot("not json {{{"));
assert.doesNotThrow(() => compactSnapshot('{"ok":false,"error":{"code":"X","message":"m"}}'));
console.log(`PASS compact-snapshot (${out.length} chars vs ${raw.length} raw)`);
