// Live smoke: node scripts/smoke.mjs "Linus Torvalds"
import { searchPerson } from "../src/index.ts";
const name = process.argv[2] ?? "Linus Torvalds";
const r = await searchPerson(name, { githubToken: process.env.GITHUB_TOKEN });
console.log(`\n=== ${name} — total ${r.ms}ms, ${r.facts.length} facts ===`);
for (const t of r.timings) console.log(`  ${t.source}: ${t.ok ? "ok" : "FAIL"} ${t.ms}ms`);
console.log("handles:", JSON.stringify(r.handles));
r.facts.slice(0, 5).forEach((f, i) => console.log(`  [${i}] ${f.summary}  <${f.sourceUrl}>`));
