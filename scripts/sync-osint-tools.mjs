import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const LIB = "services/osint-tools-library";
if (!existsSync(LIB)) {
  console.error(`Missing ${LIB}. Run: git clone --depth 1 -b GitBook https://github.com/The-OSINT-Newsletter/OSINT-Tools-Library ${LIB}`);
  process.exit(1);
}
const CATEGORIES = {
  "Core": null,
  "Username": "username-osint.md",
  "People": "people-osint.md",
  "Social Media": "social-media-osint",
  "Public Records": "public-records-osint.md",
  "Public Media": "public-media-osint.md",
  "Archiving": "archiving-osint.md",
  "Foundational": "foundational-osint-tools.md",
};
const PER_CAT = Number(process.env.PER_CAT ?? 6);
const DROP = /anywho|nuwber|spokeo|whitepages|that.?s them|fake name|anna.?s archive|lookyloo|finger ?print|human or ai|4plebs|download|saver|video downloader|stalk|phone|email|breach|leak|geoloc|reverse (lookup|phone)/i;
const SCORE = /person|people|name|profile|username|handle|company|business|news|article|archive|repository|github|publication|patent/gi;

const CORE = [
  { name: "Google", url: "https://www.google.com", what: "General web search — primary discovery pivot.", how: 'Search "<name>", "<name>" <handle>, site: queries.' },
  { name: "DuckDuckGo", url: "https://duckduckgo.com", what: "Privacy-friendly web search.", how: "Same queries as Google; good second opinion." },
  { name: "GitHub", url: "https://github.com", what: "Code host — repositories, profiles, orgs.", how: "Search users by name/handle; read public profile + repos." },
  { name: "LinkedIn (public)", url: "https://www.linkedin.com", what: "Professional profiles, public pages only.", how: "Search name; only read pages visible without login." },
  { name: "Wikipedia", url: "https://www.wikipedia.org", what: "Encyclopedia — notable people/orgs.", how: "Search name; check references + talk pages." },
];

const field = (md, key) => {
  const m = md.match(new RegExp(`^\\|\\s*${key}\\s*\\|\\s*(.*?)\\s*\\|\\s*$`, "mi"));
  return m ? m[1].replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim() : "";
};
const urlOf = (md) => {
  const m = md.match(/^\|\s*URL\s*\|\s*\[?(https?:\/\/[^\s\])|]+)/mi);
  return m ? m[1] : "";
};
function toolFiles(catPath) {
  const full = join(LIB, "tool-categories", catPath);
  const files = statSync(full).isDirectory() ? readdirSync(full).map((f) => join(full, f)) : [full];
  const out = [];
  for (const f of files.filter((f) => f.endsWith(".md") && !f.endsWith("README.md"))) {
    const md = readFileSync(f, "utf8");
    for (const m of md.matchAll(/\]\(\.\.\/(?:\.\.\/)?osint-tools\/([^)]+\.md)\)/g)) out.push(m[1]);
    for (const m of md.matchAll(/href="(?:\.\.\/)+osint-tools\/([^"]+\.md)"/g)) out.push(m[1]);
  }
  return [...new Set(out)];
}

const categories = { Core: CORE };
let total = CORE.length;
for (const [cat, path] of Object.entries(CATEGORIES)) {
  if (!path) continue;
  const list = [];
  for (const file of toolFiles(path)) {
    const p = join(LIB, "osint-tools", file);
    if (!existsSync(p)) continue;
    const md = readFileSync(p, "utf8");
    const url = urlOf(md);
    const cost = field(md, "Cost");
    const account = field(md, "Account required");
    if (!url || !/^free/i.test(cost) || !/^no/i.test(account)) continue;
    const name = (md.match(/^# (.+)$/m)?.[1] ?? file).trim();
    const what = field(md, "What it does"), how = field(md, "How to use it");
    if (DROP.test(name) || DROP.test(what)) continue;
    const score = (`${what} ${how}`.match(SCORE) ?? []).length;
    list.push({ name, url, what: what.slice(0, 140), how: how.slice(0, 160), score });
  }
  list.sort((a, b) => b.score - a.score);
  const top = list.slice(0, PER_CAT).map(({ score, ...t }) => t);
  if (top.length) { categories[cat] = top; total += top.length; }
}
writeFileSync("runtime/agent-image/tools.json", JSON.stringify({ source: "The-OSINT-Newsletter/OSINT-Tools-Library (+ hand-written Core)", categories }, null, 2) + "\n");
console.log(`tools.json: ${total} tools across ${Object.keys(categories).length} categories`);
for (const [c, l] of Object.entries(categories)) console.log(`  ${c}: ${l.map((t) => t.name).join(", ")}`);
