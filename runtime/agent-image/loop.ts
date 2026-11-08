import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { compactSnapshot } from "./compact.js";
import { searchPerson, fetchTexts, verifyProfiles } from "./lane/index.js";
import { writeFileSync, unlinkSync } from "node:fs";
import { execFile as execFileCb } from "node:child_process";

const run = promisify(execFile);

const PHONE = /(\+\d[\d\s().-]{7,}\d|\d[\d\s().-]{9,}\d)/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const STREET =
  /\b\d{1,6}\s+[A-Za-z0-9.\s]{2,40}\s(street|st\.?|avenue|ave\.?|road|rd\.?|lane|ln\.?|drive|dr\.?|boulevard|blvd\.?|way|court|ct\.?|place|pl\.?|parkway|pkwy\.?|terrace|ter\.?)\b/gi;

function filterSensitive(text: string): string {
  return text
    .replace(EMAIL, "[redacted-email]")
    // >=10 digits, or + followed by >=8 digits; year ranges/dates have too few digits
    .replace(PHONE, (m) => {
      const digits = (m.match(/\d/g) ?? []).length;
      return digits >= 10 || (m.trimStart().startsWith("+") && digits >= 8) ? "[redacted-phone]" : m;
    })
    .replace(STREET, "[redacted-address]");
}

const RUN_ID = process.env.RUN_ID ?? "local";
const MAX_STEPS = Number(process.env.MAX_STEPS ?? 40);
const STEP_DELAY_MS = Number(process.env.STEP_DELAY_MS ?? 0);
const BASE = (process.env.MODEL_BASE_URL ?? "").replace(/\/$/, "");
const MODEL = process.env.MODEL_NAME ?? "holo";
const KEY = process.env.MODEL_API_KEY ?? "";
const SUBJECT = JSON.parse(process.env.SUBJECT_JSON ?? "{}");
const TASK = process.env.TASK ?? "";
const TASK_EXTRA = process.env.TASK_EXTRA ?? "";
const GENERIC = !!TASK && !process.env.SUBJECT_JSON;
const TOOLS = JSON.parse(readFileSync("/agent/tools.json", "utf8"));

function emit(kind: string, data: unknown) {
  process.stdout.write(
    JSON.stringify({ runId: RUN_ID, ts: new Date().toISOString(), kind, data }) + "\n"
  );
}

function envError(raw: string): string | undefined {
  try {
    const env = JSON.parse(raw);
    if (env && env.ok === false && env.error) {
      const e = env.error;
      return `${e.code ?? "ERROR"}: ${e.message ?? ""}${e.suggestion ? ` (${e.suggestion})` : ""}`;
    }
  } catch {}
  return undefined;
}

async function ad(args: string[]): Promise<string> {
  try {
    const { stdout } = await run("agent-desktop", args, { maxBuffer: 32 * 1024 * 1024 });
    const err = envError(stdout);
    if (err) throw new Error(err);
    return stdout;
  } catch (e: any) {
    const real = envError(e?.stdout ?? "") ?? envError(e?.stderr ?? "");
    if (real) throw new Error(real);
    throw new Error(String(e?.stderr ?? e?.stdout ?? e?.message ?? e).slice(0, 200));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function snapshotFirefox(): Promise<string> {
  let lastErr: unknown;
  for (let i = 0; i < 15; i++) {
    try {
      return await ad(["snapshot", "--app", "Firefox", "-i"]);
    } catch (e) {
      lastErr = e;
      await sleep(2000);
    }
  }
  throw lastErr;
}

const EFFORT = process.env.MODEL_REASONING_EFFORT ?? "";

class ModelError extends Error {
  constructor(public status: number, body: string) {
    super(`model ${status}: ${body}`);
  }
}

let authFailures = 0;

async function chat(messages: unknown[]): Promise<string> {
  let backoff = 8;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL, messages, temperature: 0.2,
        ...(EFFORT ? { reasoning_effort: EFFORT } : {}),
      }),
    });
    if (res.status === 429 && attempt < 6) {
      const ra = Number(res.headers.get("retry-after"));
      const seconds = Math.min(30, Number.isFinite(ra) && ra > 0 ? ra : backoff);
      emit("log", { msg: "rate limited, waiting", seconds });
      await sleep(seconds * 1000);
      backoff = Math.min(30, backoff * 2);
      continue;
    }
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) authFailures++;
      else authFailures = 0;
      if (authFailures >= 3) {
        emit("log", { msg: "fatal", err: "model auth failed" });
        emit("log", { msg: "finished", ok: false });
        process.exit(1);
      }
      throw new ModelError(res.status, await res.text());
    }
    authFailures = 0;
    const json: any = await res.json();
    return json.choices?.[0]?.message?.content ?? "";
  }
}

export function parseAction(text: string): any {
  // first balanced top-level JSON object/array, string-aware
  const clean = text.replace(/```(?:json)?\s*|```/g, " ");
  let depth = 0, inStr = false, esc = false, start = -1;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === "{" || c === "[") { if (depth++ === 0) start = i; continue; }
    if (c === "}" || c === "]") {
      if (depth > 0 && --depth === 0 && start >= 0)
        return JSON.parse(clean.slice(start, i + 1));
    }
  }
  throw new Error("no JSON action in reply");
}

const GENERIC_SYSTEM = `You are a computer-use agent driving a Linux desktop with Firefox.
Task: ${TASK}
Rules: public information only; never log in, never bypass access controls or paywalls; no purchases or real-world side-effect submissions; don't collect private info about private individuals.
Fast lane first — direct API actions, ONE action per reply as raw JSON (lane actions can be BATCHED: {"actions":[<up to 6 lane actions>]}):
{"action":"search_person","name":"<full name>"} — instant facts+handles for a PERSON query
{"action":"fetch","urls":["https://...",...up to 6],"offset":<chars to skip>} — read page text; use offset for long pages, NEVER scroll
{"action":"username","handle":"<handle>","name":"<person>"} — sweep 150 sites for a handle
Browser actions (ONE per reply, never inside an actions array):
{"action":"launch","url":"https://..."}
{"action":"look"} — view the current page
{"action":"click","ref":"<a11y ref from snapshot>"}
{"action":"type","ref":"<a11y ref>","text":"..."}
{"action":"press","keys":"return"}
{"action":"done","summary":"short plain-text result","findings":[{"sourceUrl":"https://…","summary":"<fact>"}]} — list every fact you found (5-12 findings); findings may be omitted only when the task produced none
Navigate by URL with "launch" whenever possible instead of typing into search boxes.
Do NOT use Google (consent wall/locale). Use DuckDuckGo's HTML endpoint for searches:
https://html.duckduckgo.com/html/?q=<url-encoded query>, direct Wikipedia pages
https://en.wikipedia.org/wiki/<Title_With_Underscores>, GitHub https://github.com/<user>,
Wayback https://web.archive.org/web/<url>. If a cookie/consent dialog appears (see DIALOGS),
accept/dismiss it first. Never scroll — the compact snapshot already contains all page text
(PAGE TEXT + INTERACTIVE refs), and fetch with offset reads the rest. Refs marked (offscreen) are handled automatically.
Start with a "launch" action if a site is needed. Finish with "done" and a short plain-text summary.
Don't spend more than ~15 steps.`;

const SYSTEM = GENERIC ? GENERIC_SYSTEM : `You are an OSINT research agent driving a Linux desktop with Firefox.
Subject: ${JSON.stringify(SUBJECT)}
Rules: public data only; only visit the subject's approvedSources categories; never log in, never bypass access controls, never collect data on private third parties (family, friends).
Fast lane first — direct API actions, ONE action per reply as raw JSON (lane actions can be BATCHED: {"actions":[<up to 6 lane actions>]} executed concurrently):
{"action":"search_person","name":"<full name>"} — instant facts+handles from Wikipedia/Wikidata/GitHub/OpenAlex/HN
{"action":"fetch","urls":["https://...",...up to 6],"offset":<chars to skip>} — read page text; use offset for long pages, NEVER scroll
{"action":"username","handle":"<handle>","name":"<person>"} — sweep 150 sites for the handle, auto-verified by name match
Browser actions (ONE per reply, never inside an actions array):
{"action":"launch","url":"https://..."} — open a page in real Firefox
{"action":"look"} — view the current page (use after launch or when a page changed)
{"action":"click","ref":"<a11y ref from snapshot>"}
{"action":"type","ref":"<a11y ref>","text":"..."}
{"action":"note","sourceUrl":"https://...","summary":"..."}
{"action":"done","summary":"2-4 sentence overview","findings":[{"sourceUrl":"https://…","summary":"<one-sentence fact>"}]} — final done MUST list 5-12 findings each with its sourceUrl; facts from OBSERVATIONs only
Playbook: (1) "search_person" first (your leads env may already answer); (2) from its "handles" run "username" with the name for verification; (3) "fetch" several relevant URLs in ONE batched step to read full pages — you may combine fetches and notes in one actions array; (4) the real browser is a LAST-RESORT fallback ONLY when a fetch returned ok:false, status>=400 or <200 chars for a page that matters — you already have the page text from fetch, do NOT open the browser to re-read it; (5) after every search_person/username/fetch observation, the VERY NEXT action SHOULD be "note" actions (batch up to 8) — each note takes sourceUrl + a one-sentence fact from OBSERVATION text only; (6) cross-check >=2 independent sources; (7) finish with "done" listing 5-12 findings with sourceUrls — done.findings is the PRIMARY way to record facts; target <=12 steps.
Navigation rules: prefer "launch" with a direct URL or "fetch" over typing into search boxes. Do NOT use Google (consent wall/locale). DuckDuckGo works ONLY via the browser (launch html.duckduckgo.com/html/?q=<query>), never via "fetch". If a cookie/consent dialog appears (DIALOGS), accept/dismiss first. Do NOT scroll — read PAGE TEXT; all page text is already there. Refs marked (offscreen) are handled automatically.
These OSINT starting points are available if needed:
Tools (Category: Name <url> - what):
${Object.entries(TOOLS.categories ?? {}).map(([c, l]: any) => l.map((t: any) => `${c}: ${t.name} <${t.url}> - ${t.what}`).join("\n")).join("\n")}
Playbook: (1) start with Core search for the name plus any handles; (2) pivot — handle -> Username tools, name -> People/Public Records/Public Media; confirm identity by cross-referencing >=2 independent sources before recording a fact; (3) use Archiving (Wayback) for dead pages; (4) record each fact as a "note" with the exact source URL; (5) skip anything revealing home address, phone, email, or family.
Navigation: prefer "launch" with a direct URL over typing into search boxes. Do NOT use Google
(consent wall/locale) — prefer the DuckDuckGo HTML endpoint https://html.duckduckgo.com/html/?q=<query>
over Google for searches. If a cookie/consent dialog appears (see DIALOGS), accept/dismiss it first.
Do NOT scroll — read PAGE TEXT; the compact snapshot already contains all page text. Refs marked (offscreen) need a focus+click, which is done automatically.
Record a "note" for each durable fact right away; finish with "done" after 6-12 facts or when
sources are exhausted; don't spend more than ~15 steps.
Use "note" whenever you find a durable fact about the subject. Finish with "done".${TASK_EXTRA ? `\n\nAdditional instructions from the user: ${TASK_EXTRA}` : ""}`;

const notes: string[] = [];
const finalFinding = (summary: string) =>
  emit("finding", { runId: RUN_ID, sourceUrl: "", summary: filterSensitive(summary), ts: new Date().toISOString() });

interface SnapNode {
  role?: string; name?: string; ref_id?: string; states?: string[]; children?: SnapNode[];
}
function walkNodes(n: SnapNode, fn: (n: SnapNode) => void) {
  fn(n);
  for (const c of n.children ?? []) walkNodes(c, fn);
}
function nodeByRef(raw: string, ref: string): SnapNode | undefined {
  try {
    const tree = JSON.parse(raw)?.data?.tree;
    let found: SnapNode | undefined;
    if (tree) walkNodes(tree, (n) => { if (!found && n.ref_id === ref) found = n; });
    return found;
  } catch { return undefined; }
}
function refForRoleName(raw: string, role: string | undefined, name: string | undefined): string | undefined {
  try {
    const tree = JSON.parse(raw)?.data?.tree;
    const matches: SnapNode[] = [];
    if (tree) walkNodes(tree, (n) => {
      if (n.ref_id && n.role === role && (n.name ?? "") === (name ?? "")) matches.push(n);
    });
    const onscreen = matches.find((m) => !(m.states ?? []).includes("offscreen"));
    return (onscreen ?? matches[0])?.ref_id;
  } catch { return undefined; }
}
const RETRYABLE = /STALE_REF|TIMEOUT|AMBIGUOUS_TARGET/;
const LEADS = (() => { try { return JSON.parse(process.env.LEADS_JSON ?? "null"); } catch { return null; } })();
const laneNorm = (x: string) => (x ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

function maigret(handle: string): Promise<string[]> {
  const out = `/tmp/mg-${Date.now()}.txt`;
  const args = [handle, "--top-sites", "150", "--timeout", "4", "--no-recursion", "--no-extracting", "--no-progressbar", "--json", "simple", "--folderoutput", "/tmp"];
  return new Promise((resolve) => {
    execFileCb("/opt/osint-venv/bin/maigret", args, { timeout: 25000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      const urls = new Set<string>();
      for (const m of String(stdout ?? "").matchAll(/https?:\/\/\S+/g)) urls.add(m[0].replace(/[),.;]+$/, ""));
      try { unlinkSync(out); } catch {}
      resolve([...urls]);
    });
  });
}

const laneOk = (obs: string, max = 2500) => (obs.length > max ? obs.slice(0, max) + "\n…[truncated]" : obs);

async function runLane(a: any): Promise<string> {
  const t0 = Date.now();
  let obs = "";
  try {
    if (a.action === "search_person") {
      const name = String(a.name ?? "");
      let r: any;
      if (LEADS && laneNorm(LEADS.name) === laneNorm(name)) {
        r = { facts: LEADS.facts ?? [], handles: LEADS.handles ?? {}, timings: [{ source: "leads", ok: true, ms: 0 }] };
      } else {
        r = await searchPerson(name, { githubToken: process.env.GITHUB_TOKEN });
      }
      const lines = (r.facts ?? []).map((f: any) => `- ${f.summary} [${f.source}] ${f.sourceUrl}`);
      obs = `HANDLES: ${JSON.stringify(r.handles ?? {})}\n` +
        `TIMINGS: ${(r.timings ?? []).map((t: any) => `${t.source}:${t.ms}ms`).join(" ")}\n` +
        `FACTS:\n${lines.join("\n")}`;
    } else if (a.action === "fetch") {
      const pages = await fetchTexts((a.urls ?? []).slice(0, 6), { maxChars: Math.min(9000, Math.max(500, Number(a.maxChars) || 3000)) });
      const off = Math.max(0, Number(a.offset) || 0);
      obs = pages.map((p) => {
        const body = off ? p.text.slice(off) : p.text;
        return `### ${p.url} (${p.status}, ${p.ms}ms)${p.ok ? "" : " FAILED"}${off ? ` [offset ${off}]` : ""}\n${body}`;
      }).join("\n\n");
      return laneOk(obs, 12000);
    } else if (a.action === "username") {
      const urls = await maigret(String(a.handle ?? ""));
      if (a.name && urls.length) {
        const v = await verifyProfiles(String(a.name), urls.slice(0, 12));
        obs = v.verified.length
          ? `VERIFIED profiles (name matched on page):\n${v.verified.map((x) => `- ${x.url} ("${x.evidence}")`).join("\n")}\n` +
            `${v.unverified.length} unverified (squatted-name risk): ${v.unverified.slice(0, 5).join(" ")}`
          : `No verified profiles among ${urls.length} hits. Unverified (squatted-name risk): ${urls.slice(0, 5).join(" ")}`;
      } else {
        obs = `${urls.length} profile-url candidates (unverified):\n${urls.slice(0, 15).join("\n")}`;
      }
    } else if (a.action === "look") {
      return ""; // snapshot handled by caller
    } else {
      obs = `unknown lane action ${a.action}`;
    }
  } catch (e: any) {
    obs = `lane ${a.action} failed: ${String(e?.message ?? e).slice(0, 200)}`;
  }
  emit("log", { msg: "lane", action: a.action, ms: Date.now() - t0, ok: !obs.startsWith("lane ") });
  return laneOk(obs);
}

async function main() {
  let ok = false;
  let lastFailure = "";
  let consecFails = 0;
  let lastActionJson = "";
  let doneRetried = false;
  emit("log", { msg: "agent starting", subject: GENERIC ? TASK.slice(0, 80) : SUBJECT.name });
  const history: any[] = [{ role: "system", content: SYSTEM }];
  const recordedNotes: string[] = [];
  let guiBlocked = 0;
  let laneEverFailed = false;
  let laneEverUsed = false;
  const DEBUG_HISTORY = process.env.DEBUG_HISTORY === "1";
  const ledger = () => `\nNOTES RECORDED (${recordedNotes.length})${recordedNotes.length ? ": " + recordedNotes.slice(-12).join(" | ") : " — record facts as note actions now"}`;
  const ledgerLine = () => {
    const l = ledger();
    return `NOTES RECORDED (${recordedNotes.length})${recordedNotes.length ? ": " + recordedNotes.slice(-12).join(" | ") : " — record facts as note actions now"}`;
  };
  let lastRaw = "";
  const takeSnapshot = async () => {
    const raw = await snapshotFirefox();
    lastRaw = raw;
    return compactSnapshot(raw);
  };
  let guiPending = false;
  let lastObs = "";
  for (let step = 0; step < MAX_STEPS; step++) {
    let stepObs = "";
    if (step === 0) {
      stepObs = "No browser view yet. Prefer search_person / fetch / username; use launch+look only when a page needs the real browser.";
    } else if (guiPending) {
      try {
        stepObs = `A11Y SNAPSHOT:\n${await takeSnapshot()}`;
      } catch (e: any) {
        emit("log", { msg: "snapshot failed", err: String(e?.message ?? e) });
      }
      guiPending = false;
    } else {
      stepObs = lastObs || "Continue.";
    }
    // compact: stub older GUI snapshots, keep lane observations + recent messages
    for (const m of history) {
      if (m.role === "user" && typeof m.content === "string" && m.content.includes("A11Y SNAPSHOT") && !m.__latestSnap)
        m.content = "[older browser snapshot omitted]";
    }
    while (history.length > 30) history.splice(1, 2);
    history.push({ role: "user", content: `STEP ${step}\n${stepObs}\n${ledgerLine()}` });
    let action: any;
    if (DEBUG_HISTORY) {
      try { writeFileSync("/tmp/history.jsonl", history.map((m) => JSON.stringify(m)).join("\n") + "\n", { flag: "a" }); } catch {}
    }
    emit("log", { msg: "ctx", step, messages: history.length, promptChars: history.reduce((a, m) => a + String(m.content ?? "").length, 0), obsChars: stepObs.length, noteCount: recordedNotes.length });
    try {
      const m0 = Date.now();
      const reply = await chat(history);
      emit("log", { msg: "model", ms: Date.now() - m0 });
      history.push({ role: "assistant", content: reply });
      action = parseAction(reply);
    } catch (e: any) {
      emit("log", { msg: "model/parse error", err: String(e?.message ?? e) });
      try {
        const m0 = Date.now();
        const retry = await chat([...history, { role: "user", content: "Reply with ONE valid JSON action only." }]);
        emit("log", { msg: "model", ms: Date.now() - m0 });
        action = parseAction(retry);
        history.push({ role: "assistant", content: retry });
      } catch (e2: any) {
        emit("log", { msg: "model/parse error", err: String(e2?.message ?? e2) });
        continue;
      }
    }
    emit("action", action);
    if (STEP_DELAY_MS > 0) await sleep(STEP_DELAY_MS);
    const laneBatch: any[] | undefined = Array.isArray(action?.actions) ? action.actions : undefined;
    try {
      const runAction = async (ref?: string) => {
        switch (action.action) {
          case "click":
          case "type": {
            const r = ref ?? String(action.ref);
            const node = lastRaw ? nodeByRef(lastRaw, r) : undefined;
            if (node?.states?.includes("offscreen")) {
              // headed focus scrolls the element into view, making it clickable
              await ad(["--headed", "focus", r]);
            }
            if (action.action === "click") await ad(["click", r]);
            else await ad(["type", "--headed", r, String(action.text ?? "")]);
            break;
          }
          case "press":
            await ad(["press", "--headed", String(action.keys ?? "")]);
            break;
          case "scroll": {
            // ref-based scroll is broken headless (POLICY_DENIED) and headed
            // (pointer delivery unproven); mouse-wheel over page center works
            const dir = ["up", "down", "left", "right"].includes(action.direction) ? action.direction : "down";
            const dy = (dir === "down" ? -1 : 1) * Math.max(1, Number(action.amount) || 3) * 5;
            await ad(["--headed", "mouse-wheel", "--x", "640", "--y", "400", "--dy", String(dy)]);
            break;
          }
          case "launch":
            await run("firefox", ["--new-tab", String(action.url)]);
            await sleep(2500); // let the page settle; late actions hit STALE_REF
            break;
        }
      };
      const GUI = new Set(["launch", "click", "type", "press"]);
      const LANE = new Set(["search_person", "fetch", "username", "look"]);
      if (laneBatch && laneBatch.length) {
        if (laneBatch.length > 8 || laneBatch.some((x) => GUI.has(x?.action) || x?.action === "done")) {
          emit("log", { msg: "lane batch contained a GUI/done action — ignored", action: "batch" });
        } else {
          const lane = laneBatch.filter((x) => x?.action !== "note");
          for (const n of laneBatch.filter((x) => x?.action === "note")) {
            if (n.summary) { notes.push(String(n.summary).slice(0, 300)); recordedNotes.push(String(n.summary).slice(0, 140)); }
            emit("finding", { runId: RUN_ID, sourceUrl: String(n.sourceUrl ?? ""), summary: filterSensitive(String(n.summary ?? "")), ts: new Date().toISOString() });
          }
          const obs = await Promise.all(lane.slice(0, 6).map(runLane));
          lastObs = `OBSERVATION:\n${obs.filter(Boolean).join("\n---\n")}`;
          laneEverUsed = true;
          if (!obs.filter(Boolean).length || obs.some((o) => o.startsWith("lane "))) laneEverFailed = true;
          continue;
        }
      }
      if (LANE.has(action.action)) {
        const t0 = Date.now();
        const o = await runLane(action);
        lastObs = action.action === "look" ? o || "(no snapshot)" : `OBSERVATION:\n${o}`;
        laneEverUsed = true;
        if (!o || o.startsWith("lane ")) laneEverFailed = true;
        emit("log", { msg: "lane done", action: action.action, ms: Date.now() - t0 });
        continue;
      }
      if (action.action === "scroll") {
        emit("log", { msg: "scroll disabled — telling model to use fetch offset", action: "scroll" });
        lastObs = "OBSERVATION: scroll is disabled; use fetch with offset to read more or note what you have.";
        laneEverFailed = true;
        consecFails++;
        continue;
      }
      if (GUI.has(action.action) && step < 4 && !laneEverFailed && guiBlocked < 3 && laneEverUsed) {
        guiBlocked++;
        emit("log", { msg: "gui blocked", action: action.action, count: guiBlocked });
        lastObs = "OBSERVATION: GUI blocked — you have unrecorded lane results; call note now, or fetch a different URL.";
        continue;
      }
      switch (action.action) {
        case "click":
        case "type":
        case "press":
        case "scroll":
        case "launch": {
          try {
            await runAction();
          } catch (e: any) {
            const err = String(e?.message ?? e);
            const needsRef = (action.action === "click" || action.action === "type") && action.ref;
            if (!RETRYABLE.test(err) || !needsRef) throw e;
            // auto-rescue once: fresh snapshot, re-resolve by role+name
            const target = nodeByRef(lastRaw, String(action.ref));
            emit("log", { msg: "ref stale, retrying with fresh snapshot", action: action.action });
            const fresh = await snapshotFirefox();
            const newRef = refForRoleName(fresh, target?.role, target?.name);
            if (!newRef) throw e;
            lastRaw = fresh;
            await runAction(newRef);
          }
          break;
        }
        case "note":
          if (action.summary) { notes.push(String(action.summary).slice(0, 300)); recordedNotes.push(String(action.summary).slice(0, 140)); }
          emit("finding", {
            runId: RUN_ID,
            sourceUrl: String(action.sourceUrl ?? ""),
            summary: filterSensitive(String(action.summary ?? "")),
            ts: new Date().toISOString(),
          });
          break;
        case "done": {
          const findings = Array.isArray(action.findings) ? action.findings : [];
          const good = findings.filter((f: any) =>
            typeof f?.summary === "string" && f.summary.trim() && /^https?:\/\//.test(String(f.sourceUrl ?? ""))
          ).slice(0, 12);
          if (good.length + recordedNotes.length < 3 && !doneRetried) {
            doneRetried = true;
            consecFails++; // soft failure, does not bail
            lastObs = `OBSERVATION: Not enough sourced findings: put 5-12 {sourceUrl, summary} entries in done.findings (facts from your OBSERVATIONs only). You have ${good.length + recordedNotes.length}.`;
            continue;
          }
          for (const f of good) {
            const sum = filterSensitive(String(f.summary).slice(0, 300));
            notes.push(sum); recordedNotes.push(String(f.summary).slice(0, 140));
            emit("finding", { runId: RUN_ID, sourceUrl: String(f.sourceUrl), summary: sum, ts: new Date().toISOString() });
          }
          emit("finding", {
            runId: RUN_ID,
            sourceUrl: "",
            summary: filterSensitive(String(action.summary ?? "")),
            ts: new Date().toISOString(),
          });
          emit("log", { msg: "done" });
          await sleep(1500);
          emit("log", { msg: "finished", ok: true });
          return;
        }
        default:
          emit("log", { msg: "unknown action", action });
      }
      if (GUI.has(action.action)) guiPending = true;
      consecFails = 0;
    } catch (e: any) {
      const err = String(e?.message ?? e);
      lastFailure = err;
      consecFails++;
      emit("log", { msg: "action failed", action: action.action, err });
      const actionJson = JSON.stringify(action);
      const repeat = actionJson === lastActionJson
        ? " You already tried this exact action — DO NOT repeat it." : "";
      lastActionJson = actionJson;
      history.push({
        role: "user",
        content:
          `LAST ACTION FAILED: ${actionJson} -> ${err}.${repeat} ` +
          `Choose a different approach; refs are only valid for the snapshot they came from; ` +
          `scroll/press must target the SCROLL-TARGET / focused element.`,
      });
      if (consecFails >= 6) {
        emit("log", { msg: "giving up after 6 consecutive action failures" });
        break;
      }
    }
  }
  emit("log", { msg: "max steps reached" });
  if (!ok) {
    finalFinding(notes.length
      ? `Partial findings before run ended: ${notes.join(" | ")}`
      : `No findings recorded: ${lastFailure || "model did not finish"}`);
  }
  emit("log", { msg: "finished", ok });
}

main().catch((e) => {
  emit("log", { msg: "fatal", err: String(e?.message ?? e) });
  emit("log", { msg: "finished", ok: false });
  process.exit(1);
});
