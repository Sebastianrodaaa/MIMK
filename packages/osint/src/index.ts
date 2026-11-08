// Fast OSINT lane: direct API calls only, zero deps, Node 20 fetch.
// Every source has a 2.5s timeout + one retry on 429/5xx, never throws.
import { filterSensitive } from "./sensitive.js";

export type Fact = { summary: string; sourceUrl: string; source: string };
export type Handles = Partial<
  Record<"github" | "twitter" | "instagram" | "mastodon" | "website" | "linkedin" | "orcid", string>
>;
export type SourceResult = {
  source: string;
  ok: boolean;
  ms: number;
  facts: Fact[];
  handles: Handles;
};

type FetchFn = typeof fetch;

const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0 MIMK/1.0";

export const norm = (s: string) =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const tokens = (s: string) => norm(s).split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
const tokenSubset = (needles: string[], haystack: string[]) =>
  needles.every((n) => haystack.some((h) => h === n || h.startsWith(n)));

async function req(
  url: string,
  fetchFn: FetchFn = fetch,
  timeoutMs = 2500,
  headers: Record<string, string> = {},
): Promise<{ ok: boolean; status: number; body: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchFn(url, {
        headers: { "user-agent": UA, accept: "application/json,*/*", ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      } as any);
      if ((res.status === 429 || res.status >= 500) && attempt === 0) {
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      return { ok: res.ok, status: res.status, body: await res.text() };
    } catch (e: any) {
      if (attempt === 0) await new Promise((r) => setTimeout(r, 300));
      else return { ok: false, status: 0, body: "" };
    }
  }
  return { ok: false, status: 0, body: "" };
}

const J = (body: string) => { try { return JSON.parse(body); } catch { return undefined; } };

async function wikiSource(name: string, fetchFn: FetchFn): Promise<SourceResult> {
  const t0 = Date.now();
  const out: SourceResult = { source: "wikipedia", ok: false, ms: 0, facts: [], handles: {} };
  const nameToks = tokens(name);
  const s = J((await req(
    `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(name)}&format=json&srlimit=3`,
    fetchFn)).body);
  const candidates = s?.query?.search ?? [];
  for (const hit of candidates.slice(0, 3)) {
    const title: string = hit.title ?? "";
    // wrong-person guard: the article title must contain all name tokens
    if (!tokenSubset(nameToks, tokens(title))) continue;
    const sum = J((await req(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
      fetchFn)).body);
    const extract: string = sum?.extract ?? "";
    if (!extract) continue;
    const sentences = extract.split(/(?<=[.!?])\s+/);
    const fact = sentences.slice(0, 2).join(" ").trim().slice(0, 220);
    out.facts.push({
      summary: fact,
      sourceUrl: sum?.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
      source: "wikipedia",
    });
    out.ok = true;
    break;
  }
  out.ms = Date.now() - t0;
  return out;
}

const WD_HANDLE_PROPS: Record<string, keyof Handles> = {
  P2037: "github", P2002: "twitter", P2003: "instagram",
  P4033: "mastodon", P6634: "linkedin", P496: "orcid", P856: "website",
};

async function wikidataSource(name: string, fetchFn: FetchFn): Promise<SourceResult> {
  const t0 = Date.now();
  const out: SourceResult = { source: "wikidata", ok: false, ms: 0, facts: [], handles: {} };
  const nameToks = tokens(name);
  const s = J((await req(
    `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(name)}&language=en&format=json&limit=5&type=item`,
    fetchFn)).body);
  const ids: string[] = (s?.search ?? []).map((x: any) => x.id).filter(Boolean);
  if (!ids.length) { out.ms = Date.now() - t0; return out; }
  const ent = J((await req(
    `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${ids.join("|")}&props=claims|labels&languages=en&format=json`,
    fetchFn)).body);
  const entities = ent?.entities ?? {};
  let person: any;
  for (const id of ids) {
    const e = entities[id];
    if (!e) continue;
    const label = e.labels?.en?.value ?? "";
    const isHuman = (e.claims?.P31 ?? []).some((c: any) => c.mainsnak?.datavalue?.value?.id === "Q5");
    if (isHuman && tokenSubset(nameToks, tokens(label))) { person = e; break; }
  }
  if (!person) { out.ms = Date.now() - t0; return out; }
  const qid = person.id;
  const claims = person.claims ?? {};
  // handles
  for (const [prop, key] of Object.entries(WD_HANDLE_PROPS)) {
    const v = claims[prop]?.[0]?.mainsnak?.datavalue?.value;
    if (typeof v === "string" && v.trim()) {
      // project rule: never surface family info
      if (key === "website" && /family/i.test(v)) continue;
      out.handles[key] = v.trim();
    }
  }
  // facts from labeled claims
  const labelProps: Record<string, string> = { P106: "Occupation", P108: "Employer", P69: "Educated at" };
  const valueIds: string[] = [];
  const propValues: Record<string, string[]> = {};
  for (const p of Object.keys(labelProps)) {
    propValues[p] = (claims[p] ?? [])
      .map((c: any) => c.mainsnak?.datavalue?.value?.id)
      .filter((x: any) => typeof x === "string")
      .slice(0, 4);
    valueIds.push(...propValues[p]);
  }
  let labels: Record<string, string> = {};
  if (valueIds.length) {
    const le = J((await req(
      `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${[...new Set(valueIds)].join("|")}&props=labels&languages=en&format=json`,
      fetchFn)).body);
    for (const [k, v] of Object.entries(le?.entities ?? {}))
      labels[k] = (v as any)?.labels?.en?.value ?? k;
  }
  for (const [p, label] of Object.entries(labelProps)) {
    const vals = propValues[p].map((id) => labels[id]).filter(Boolean);
    if (vals.length)
      out.facts.push({ summary: `${label}: ${vals.join(", ")}`, sourceUrl: `https://www.wikidata.org/wiki/${qid}`, source: "wikidata" });
  }
  out.ok = out.facts.length > 0 || Object.keys(out.handles).length > 0;
  out.ms = Date.now() - t0;
  return out;
}

async function githubSource(name: string, fetchFn: FetchFn, token?: string): Promise<SourceResult> {
  const t0 = Date.now();
  const out: SourceResult = { source: "github", ok: false, ms: 0, facts: [], handles: {} };
  const nameToks = tokens(name);
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  const s = J((await req(
    `https://api.github.com/search/users?q=${encodeURIComponent(name)}+in:fullname&per_page=3`,
    fetchFn, 2500, headers)).body);
  for (const item of (s?.items ?? []).slice(0, 3)) {
    const login: string = item.login;
    if (!login) continue;
    const u = J((await req(`https://api.github.com/users/${encodeURIComponent(login)}`, fetchFn, 2500, headers)).body);
    if (!u) continue;
    const profName: string = u.name ?? u.login;
    if (!tokenSubset(nameToks, tokens(profName)) && !tokenSubset(nameToks, tokens(u.login ?? ""))) continue;
    const bits = [
      u.bio ? `Bio: ${String(u.bio).slice(0, 120)}` : "",
      u.company ? `Company: ${u.company}` : "",
      u.location ? `Location: ${u.location}` : "",
      `Repos: ${u.public_repos ?? 0}, followers: ${u.followers ?? 0}`,
    ].filter(Boolean).join("; ");
    out.facts.push({ summary: `GitHub ${login}: ${bits}`, sourceUrl: u.html_url, source: "github" });
    if (u.login) out.handles.github = u.login;
    if (u.twitter_username) out.handles.twitter = u.twitter_username;
    if (u.blog) out.handles.website = u.blog;
    out.ok = true;
    break;
  }
  out.ms = Date.now() - t0;
  return out;
}

async function openalexSource(name: string, fetchFn: FetchFn): Promise<SourceResult> {
  const t0 = Date.now();
  const out: SourceResult = { source: "openalex", ok: false, ms: 0, facts: [], handles: {} };
  const nameToks = tokens(name);
  const s = J((await req(
    `https://api.openalex.org/authors?search=${encodeURIComponent(name)}&per-page=3`,
    fetchFn)).body);
  for (const a of s?.results ?? []) {
    const display: string = a.display_name ?? "";
    const okName = tokenSubset(nameToks, tokens(display)) && tokenSubset(tokens(display), nameToks);
    if (!okName || !(a.works_count > 0)) continue;
    const inst = a.last_known_institutions?.[0]?.display_name ?? a.last_known_institution?.display_name;
    out.facts.push({
      summary: `Publications: ${a.works_count} works, ${a.cited_by_count ?? 0} citations${inst ? ` (${inst})` : ""}`,
      sourceUrl: a.id ?? `https://openalex.org/authors`,
      source: "openalex",
    });
    if (a.orcid) out.handles.orcid = a.orcid.replace(/^https?:\/\/orcid\.org\//, "");
    out.ok = true;
    break;
  }
  out.ms = Date.now() - t0;
  return out;
}

async function hnSource(name: string, fetchFn: FetchFn): Promise<SourceResult> {
  const t0 = Date.now();
  const out: SourceResult = { source: "hackernews", ok: false, ms: 0, facts: [], handles: {} };
  const nameToks = tokens(name);
  const s = J((await req(
    `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent('"' + name + '"')}&tags=story&hitsPerPage=5`,
    fetchFn)).body);
  for (const h of s?.hits ?? []) {
    const title: string = h.title ?? "";
    if (!tokenSubset(nameToks, tokens(title))) continue;
    out.facts.push({
      summary: `HN: ${title.slice(0, 140)} (${h.points ?? 0} pts)`,
      sourceUrl: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
      source: "hackernews",
    });
    out.ok = true;
  }
  out.ms = Date.now() - t0;
  return out;
}

export async function searchPerson(
  name: string,
  opts: { deadlineMs?: number; githubToken?: string; fetchFn?: FetchFn } = {},
): Promise<{
  name: string; facts: Fact[]; handles: Handles; ms: number;
  timings: { source: string; ok: boolean; ms: number }[];
}> {
  const t0 = Date.now();
  const fetchFn = opts.fetchFn ?? fetch;
  const deadline = opts.deadlineMs ?? 3000;
  const sources = [
    wikiSource(name, fetchFn),
    wikidataSource(name, fetchFn),
    githubSource(name, fetchFn, opts.githubToken),
    openalexSource(name, fetchFn),
    hnSource(name, fetchFn),
  ];
  // per-source deadline — slow sources are dropped individually
  const withDeadline = (p: Promise<SourceResult>) =>
    Promise.race([
      p,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("deadline")), deadline)),
    ]);
  const settled = await Promise.allSettled(sources.map(withDeadline));
  const facts: Fact[] = [];
  const handles: Handles = {};
  const timings: { source: string; ok: boolean; ms: number }[] = [];
  const seen = new Set<string>();
  for (const r of settled) {
    const s = r.status === "fulfilled" ? r.value : { source: "?", ok: false, ms: deadline, facts: [], handles: {} };
    timings.push({ source: s.source, ok: s.ok, ms: s.ms });
    Object.assign(handles, s.handles);
    for (const f of s.facts) {
      const key = norm(f.summary).slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      const summary = filterSensitive(f.summary.slice(0, 220));
      if (summary.trim()) facts.push({ summary, sourceUrl: f.sourceUrl, source: f.source });
      if (facts.length >= 12) break;
    }
  }
  return { name, facts: facts.slice(0, 12), handles, ms: Date.now() - t0, timings };
}

const PRIVATE_HOST =
  /^(localhost|127\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|::1|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:|\[::1\]|\[fc|\[fd)/i;

export function isPrivateUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return true;
    return PRIVATE_HOST.test(u.hostname);
  } catch {
    return true;
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<head[\s\S]*?<\/head>/i, " ")
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<nav[\s\S]*?<\/nav>|<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s+/g, " ")
    .trim();
}

export async function fetchTexts(
  urls: string[],
  opts: { maxChars?: number; timeoutMs?: number; fetchFn?: FetchFn } = {},
): Promise<{ url: string; ok: boolean; status: number; title?: string; text: string; ms: number }[]> {
  const fetchFn = opts.fetchFn ?? fetch;
  const maxChars = opts.maxChars ?? 2500;
  const timeoutMs = opts.timeoutMs ?? 3000;
  return Promise.all(
    urls.slice(0, 6).map(async (url) => {
      const t0 = Date.now();
      if (isPrivateUrl(url))
        return { url, ok: false, status: 0, text: "", ms: Date.now() - t0 };
      try {
        const res = await fetchFn(url, {
          headers: { "user-agent": UA, accept: "text/html,*/*" },
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "follow",
        } as any);
        const body = await res.text();
        const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
        const text = htmlToText(body).slice(0, maxChars);
        return { url, ok: res.ok, status: res.status, title, text, ms: Date.now() - t0 };
      } catch {
        return { url, ok: false, status: 0, text: "", ms: Date.now() - t0 };
      }
    }),
  );
}

export function nameMatches(name: string, text: string): { matched: boolean; evidence?: string } {
  const nameToks = tokens(name);
  if (!nameToks.length) return { matched: false };
  const t = norm(text);
  // all tokens present; require them within a ~200-char window
  const positions = nameToks.map((tok) => {
    const re = new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
    const m = re.exec(t);
    return m ? m.index : -1;
  });
  if (positions.some((p) => p < 0)) return { matched: false };
  const min = Math.min(...positions), max = Math.max(...positions);
  if (max - min > 200) return { matched: false };
  const snippet = text.slice(Math.max(0, min - 20), max + 60).replace(/\s+/g, " ").trim();
  return { matched: true, evidence: snippet.slice(0, 120) };
}

export async function verifyProfiles(
  name: string,
  urls: string[],
  opts: { fetchFn?: FetchFn } = {},
): Promise<{ verified: { url: string; evidence: string }[]; unverified: string[] }> {
  const pages = await fetchTexts(urls.slice(0, 6), { maxChars: 3000, fetchFn: opts.fetchFn });
  const verified: { url: string; evidence: string }[] = [];
  const unverified: string[] = [];
  for (const p of pages) {
    const m = nameMatches(name, `${p.title ?? ""} ${p.text}`);
    if (p.ok && m.matched) verified.push({ url: p.url, evidence: m.evidence! });
    else unverified.push(p.url);
  }
  return { verified, unverified };
}
