// Jev-driven OSINT research runner — System-One decision loop for person research.
// Jev only chooses among concrete candidates built by code; it never generates
// URLs, commands, or selectors (same boundary as jev-social / CUA-JEV).
import { fetchTexts, nameMatches } from "./lane/index.js";

const JEV_ENDPOINT_DEFAULT = "https://openrouter.ai/api/alpha/decisions";
const JEV_MODEL_DEFAULT = "~typesafe/jev-latest";
const JEV_TIMEOUT_MS = 15000;
const JEV_MAX_BYTES = 256 * 1024;
const MAX_DECISIONS = 16;
const WALL_CLOCK_MS = 90000;

export type JevOpts = {
  apiKey: string;
  model?: string;
  endpoint?: string;
  key?: string;
  task: string;
  rules: string[];
  state: Record<string, unknown>;
  criteria: Record<string, string>;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
};

export async function jevChoose(o: JevOpts): Promise<{ choice: string; confidence: number; elapsedMs: number }> {
  const endpoint = o.endpoint ?? process.env.JEV_ENDPOINT ?? JEV_ENDPOINT_DEFAULT;
  const body = {
    model: o.model ?? process.env.OPENROUTER_JEV_MODEL ?? JEV_MODEL_DEFAULT,
    state: o.state,
    questions: {
      [o.key ?? "action"]: {
        type: "choice",
        instructions: { task: o.task, rules: o.rules },
        criteria: o.criteria,
      },
    },
  };
  const t0 = Date.now();
  const fetchImpl = o.fetchImpl ?? fetch;
  const res = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${o.apiKey}`,
      "X-Title": "mimk",
    },
    body: JSON.stringify(body),
    redirect: "error",
    signal: o.signal ?? AbortSignal.timeout(JEV_TIMEOUT_MS),
  });
  const raw = (await res.text()).slice(0, JEV_MAX_BYTES + 1);
  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error(`jev: invalid JSON`);
  }
  if (!res.ok) {
    const msg = String(payload?.error?.message ?? "").slice(0, 120);
    throw new Error(`jev: HTTP ${res.status}${msg ? ` ${msg}` : ""}`);
  }
  const answer = payload?.answers?.[o.key ?? "action"];
  const probs = answer?.probabilities;
  const probsOk =
    probs === undefined ||
    (probs && typeof probs === "object" && !Array.isArray(probs) &&
      Object.values(probs).every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1));
  if (
    answer?.type !== "choice" ||
    !Object.hasOwn(o.criteria, answer?.choice) ||
    typeof answer?.confidence !== "number" ||
    !Number.isFinite(answer.confidence) ||
    answer.confidence < 0 || answer.confidence > 1 ||
    !probsOk
  ) {
    throw new Error("jev: invalid decision response");
  }
  return { choice: answer.choice, confidence: answer.confidence, elapsedMs: Date.now() - t0 };
}

// ---------- candidate builder ----------

export type Candidate = { id: string; kind: "fetch" | "username" | "browse" | "finish"; url?: string; handle?: string; desc: string };

const TIER1 = /^(en\.wikipedia\.org|www\.wikidata\.org|github\.com|api\.openalex\.org|openalex\.org|orcid\.org)/;
const TIER2 = /(kernel\.org|python\.org|computerhistory\.org|bbc\.|reuters\.|theguardian\.|nytimes\.|wired\.|arstechnica\.|mit\.edu|stanford\.edu|\.edu$)/;
const BLOCKED = /(linkedin\.com|facebook\.com|instagram\.com|x\.com|twitter\.com|tiktok\.com|reddit\.com|pinterest\.|tumblr\.|medium\.com|quora\.|beenverified|spokeo|whitepages|peekyou|pipl\.|truecaller|mylife\.|radaris|intelius|peoplefinders|nuwber|fastpeoplesearch|ancestry\.|familysearch|genealogy|findmypast|truthfinder)/i;

const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const mineUrls = (text: string) => [...new Set((text.match(/https?:\/\/[^\s"'<>)\]]+/g) ?? []).map((u) => u.replace(/[),.;:!?]+$/, "")))];

export function buildCandidates(o: {
  subject: string;
  facts: { summary: string; sourceUrl: string; source: string }[];
  handles: Record<string, string>;
  visited: Set<string>;
  fetched: Map<string, string>; // url -> text (for mining)
  usernameDone: boolean;
  evidence: { url: string; chars: number }[];
}): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const push = (kind: Candidate["kind"], url: string | undefined, desc: string, extra?: Partial<Candidate>) => {
    if (out.length >= 9) return;
    const id = `${kind}_${out.filter((c) => c.kind === kind).length + 1}`;
    if (url && seen.has(url)) return;
    if (url) seen.add(url);
    out.push({ id, kind, url, desc, ...extra });
  };

  const addUrl = (url: string, why: string) => {
    const h = hostOf(url);
    if (!h || BLOCKED.test(h) || o.visited.has(url)) return;
    const tier = TIER1.test(h) ? 0 : TIER2.test(h) ? 1 : 2;
    const prior = tier === 0 ? 100 : tier === 1 ? 50 : 10;
    const rel = nameMatches(o.subject, url).matched ? 5 : 0;
    pending.push({ url, why, score: prior + rel });
  };
  const pending: { url: string; why: string; score: number }[] = [];

  for (const f of o.facts) if (f.sourceUrl?.startsWith("http")) addUrl(f.sourceUrl, `source of "${f.summary.slice(0, 40)}"`);
  if (o.handles.github) addUrl(`https://github.com/${o.handles.github}`, "github profile from leads");
  if (o.handles.website && !BLOCKED.test(hostOf(o.handles.website))) addUrl(o.handles.website, "personal/official site");
  if (o.handles.orcid) addUrl(`https://orcid.org/${o.handles.orcid}`, "ORCID record");
  for (const [url, text] of o.fetched) for (const u of mineUrls(text)) addUrl(u, `link found in ${hostOf(url)}`);

  pending.sort((a, b) => b.score - a.score);
  const failedFetches = o.evidence.filter((e) => e.chars < 200 && e.chars >= 0).map((e) => e.url);
  for (const p of pending.slice(0, 6)) push("fetch", p.url, `Fetch ${p.url} as text — ${p.why} (${hostOf(p.url)})`);
  // browse candidates: URLs that already failed fetch (thin/empty text)
  for (const url of failedFetches.slice(0, 2)) {
    if (!seen.has(url)) push("browse", url, `Open ${url} in the real browser — fast fetch returned thin/blocked content`);
  }
  if (!o.usernameDone) {
    const handle = o.handles.github ?? o.handles.twitter ?? o.handles.mastodon?.split("@")[0];
    if (handle) push("username", undefined, `Sweep ~150 sites for handle "${handle}" (Maigret) and verify profiles`, { handle });
  }
  out.push({ id: "finish", kind: "finish", desc: "Stop researching — synthesize findings now" });
  return out.slice(0, 10);
}

// ---------- research runner ----------

export type JevCtx = {
  emit: (kind: string, data: any) => void;
  subject: string;
  goal: string;
  leads?: { name?: string; facts?: any[]; handles?: Record<string, string> } | null;
  searchPerson: (name: string) => Promise<any>;
  fetchText: (urls: string[]) => Promise<{ url: string; ok: boolean; status: number; title?: string; text: string; ms: number }[]>;
  usernameLane: (handle: string, name: string) => Promise<string>;
  launchGui: (url: string) => Promise<void>;       // fire-and-forget desktop open; errors swallowed by caller
  readGui: () => Promise<string>;                  // compact snapshot of the desktop
  synthesize: (prompt: string) => Promise<{ summary: string; findings: { sourceUrl: string; summary: string }[] }>;
  jevChoose: (o: JevOpts) => Promise<{ choice: string; confidence: number; elapsedMs: number }>;
  apiKey: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const RULES = [
  "public sources only; never private/personal data, login pages, or people-search sites",
  "prefer corroborating an existing fact from an independent domain",
  "choose finish only when >=10 facts from >=4 independent domains, or when no candidate adds information",
];

export async function runJevResearch(ctx: JevCtx): Promise<{ summary: string; findings: { sourceUrl: string; summary: string }[] }> {
  const now = ctx.now ?? (() => Date.now());
  const sleep = ctx.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const t0 = now();
  const visited = new Set<string>();
  const fetched = new Map<string, string>();
  const evidence: { url: string; text: string; chars: number }[] = [];
  let usernameDone = false;

  // step 0 — parallel: leads/search + fetch top-3 lead URLs (no decision needed)
  const leads = ctx.leads && ctx.leads.name && normName(ctx.leads.name) === normName(ctx.subject)
    ? ctx.leads
    : await ctx.searchPerson(ctx.subject).catch(() => ({ facts: [], handles: {} }));
  const facts: { summary: string; sourceUrl: string; source: string }[] = (leads?.facts ?? []).slice(0, 12);
  const handles: Record<string, string> = leads?.handles ?? {};
  const firstUrls = [
    ...new Set(
      [...facts.map((f) => f.sourceUrl), handles.github ? `https://github.com/${handles.github}` : ""]
        .filter((u) => u.startsWith("http") && !BLOCKED.test(hostOf(u))),
    ),
  ].slice(0, 3);
  const [pages] = await Promise.all([
    ctx.fetchText(firstUrls).catch(() => [] as any[]),
    ...firstUrls.map((u) => ctx.launchGui(u).catch(() => {})),
  ]);
  for (const p of pages ?? []) {
    visited.add(p.url);
    fetched.set(p.url, p.text);
    evidence.push({ url: p.url, text: p.text.slice(0, 2500), chars: p.ok ? p.text.length : 0 });
  }

  // decision loop
  let decisions = 0;
  let jevFails = 0;
  while (decisions < MAX_DECISIONS && now() - t0 < WALL_CLOCK_MS) {
    const candidates = buildCandidates({
      subject: ctx.subject, facts, handles, visited, fetched, usernameDone, evidence,
    });
    const actionable = candidates.filter((c) => c.kind !== "finish");
    if (!actionable.length) break;
    const criteria = Object.fromEntries(candidates.map((c) => [c.id, c.desc]));
    const state = {
      subject: ctx.subject, goal: ctx.goal, step: decisions,
      budget_left: Math.max(0, MAX_DECISIONS - decisions),
      visited: [...new Set([...visited].map(hostOf))],
      facts_count: facts.length + evidence.length,
      last_result_summary: (evidence[evidence.length - 1]?.text ?? "").slice(0, 160),
    };
    let d: { choice: string; confidence: number; elapsedMs: number };
    try {
      d = await ctx.jevChoose({
        apiKey: ctx.apiKey, task: `Pick the single best next step to research ${ctx.subject}: ${ctx.goal}`,
        rules: RULES, state, criteria, key: "action",
      });
      jevFails = 0;
    } catch (e: any) {
      jevFails++;
      const msg = String(e?.message ?? e);
      ctx.emit("log", { msg: "jev error", n: jevFails, err: msg.slice(0, 120) });
      if (jevFails >= 3 || /HTTP (401|402|403)\b/.test(msg)) throw e;
      continue;
    }
    decisions++;
    const chosen = candidates.find((c) => c.id === d.choice) ?? candidates[candidates.length - 1];
    ctx.emit("decision", {
      choice: d.choice, kind: chosen.kind, url: chosen.url,
      label: chosen.desc.slice(0, 90), confidence: d.confidence, ms: d.elapsedMs,
    });
    if (chosen.kind === "finish") break;
    if (chosen.kind === "fetch" && chosen.url) {
      const [page] = await ctx.fetchText([chosen.url]).catch(() => [] as any[]);
      void ctx.launchGui(chosen.url).catch(() => {});
      if (page) {
        visited.add(page.url);
        fetched.set(page.url, page.text);
        evidence.push({ url: page.url, text: page.text.slice(0, 2500), chars: page.ok ? page.text.length : 0 });
      } else {
        visited.add(chosen.url);
        evidence.push({ url: chosen.url, text: "", chars: 0 });
      }
    } else if (chosen.kind === "browse" && chosen.url) {
      await ctx.launchGui(chosen.url).catch(() => {});
      await sleep(2500);
      const snap = await ctx.readGui().catch(() => "");
      const text = snap.replace(/^A11Y SNAPSHOT:\n/, "").slice(0, 3000);
      visited.add(chosen.url);
      evidence.push({ url: chosen.url, text, chars: text.length });
    } else if (chosen.kind === "username" && chosen.handle) {
      usernameDone = true;
      const obs = await ctx.usernameLane(chosen.handle, ctx.subject).catch(() => "");
      evidence.push({ url: `maigret:${chosen.handle}`, text: obs.slice(0, 1500), chars: obs.length });
    }
  }

  // too little real evidence for a report — let the caller fall back to the full browsing loop
  const substantive = facts.length + evidence.filter((e) => e.chars >= 200).length;
  if (substantive < 3) throw new Error("jev: insufficient evidence");

  // synthesis — one Holo call through ctx.synthesize, deterministic fallback
  const excerpts = [
    ...facts.map((f) => `- ${f.summary} <${f.sourceUrl}>`),
    ...evidence.filter((e) => e.text.trim()).map((e) => `### ${e.url}\n${e.text.slice(0, 2500)}`),
  ].join("\n").slice(0, 30000);
  try {
    const r = await ctx.synthesize(excerpts);
    if (r?.findings?.length) return r;
  } catch {}
  const findings = facts.slice(0, 10).map((f) => ({ sourceUrl: f.sourceUrl, summary: f.summary.slice(0, 220) }));
  for (const e of evidence) {
    if (findings.length >= 8) break;
    const first = e.text.split(/(?<=[.!?])\s+/)[0]?.trim() ?? "";
    if (first.length > 30 && e.url.startsWith("http") && !findings.some((f) => f.sourceUrl === e.url))
      findings.push({ sourceUrl: e.url, summary: first.slice(0, 220) });
  }
  return {
    summary: findings.length
      ? `${ctx.subject}: research gathered ${findings.length} sourced facts across ${new Set(findings.map((f) => hostOf(f.sourceUrl))).size} domains.`
      : `Research on ${ctx.subject} produced no usable sources.`,
    findings,
  };
}

const normName = (s: string) => (s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
