// Compacts an `agent-desktop snapshot` JSON envelope into a small text view
// the model can actually use: window/tabs, dialogs, interactive refs in the
// page subtree, and readable page text. Pure function, no I/O.

interface Node {
  role?: string;
  name?: string;
  ref_id?: string;
  states?: string[];
  available_actions?: string[];
  children?: Node[];
}

const SKIP_ROLES = new Set(["menu", "menubar", "menuitem", "separator"]);
const INTERESTING_CHROME = /back|forward|reload|refresh|address|url bar|location|search with|navigate/i;
const TEXT_ROLES = new Set([
  "heading", "paragraph", "statictext", "cell", "listitem", "article",
  "caption", "blockquote", "term", "definition", "label",
]);

function isInteractive(n: Node) {
  return !!n.ref_id;
}

function isDoc(n: Node) {
  return n.role === "document" || n.role === "webarea";
}

function isDialog(n: Node) {
  return n.role === "dialog" || n.role === "alert";
}

function* walk(n: Node, skipMenus = true): Generator<Node> {
  if (skipMenus && n.role && SKIP_ROLES.has(n.role)) return;
  yield n;
  for (const c of n.children ?? []) yield* walk(c, skipMenus);
}

function* walkAll(n: Node): Generator<Node> {
  yield n;
  for (const c of n.children ?? []) yield* walkAll(c);
}

function clean(s: string, max = 80) {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

function isScrollTarget(n: Node) {
  return (n.available_actions ?? []).some((a) => /scroll/i.test(a));
}

export function compactSnapshot(raw: string): string {
  let env: any;
  try {
    env = JSON.parse(raw);
  } catch {
    return `SNAPSHOT UNPARSEABLE — raw excerpt:\n${raw.slice(0, 4000)}`;
  }
  if (env?.ok === false || !env?.data?.tree) {
    return `SNAPSHOT ERROR: ${JSON.stringify(env?.error ?? env).slice(0, 500)}\nraw excerpt:\n${raw.slice(0, 4000)}`;
  }
  const tree: Node = env.data.tree;

  const lines: string[] = [];
  lines.push(`WINDOW: ${clean(tree.name ?? "", 120)}`);

  // tabs
  const tabs: string[] = [];
  for (const n of walkAll(tree)) if (n.role === "tab" && n.name) tabs.push(clean(n.name, 80));
  if (tabs.length) lines.push(`TABS: ${tabs.join(" | ")}`);

  // document subtrees + dialogs
  const docs: Node[] = [];
  const dialogs: Node[] = [];
  for (const n of walkAll(tree)) {
    if (isDoc(n)) docs.push(n);
    else if (isDialog(n)) dialogs.push(n);
  }

  // DIALOGS
  const dialogLines: string[] = [];
  for (const d of dialogs) {
    for (const n of walk(d)) {
      const name = clean(n.name ?? "", 80);
      if (n.ref_id)
        dialogLines.push(`${n.ref_id} | ${n.role} | "${name}" | ${(n.available_actions ?? []).join(",")}`);
      else if (name && TEXT_ROLES.has(n.role ?? "")) dialogLines.push(`  text: ${name}`);
    }
  }
  if (dialogLines.length) {
    lines.push("DIALOGS:");
    lines.push(...dialogLines);
  }

  // INTERACTIVE — page content refs + useful chrome (url bar / back / reload)
  const interactive: string[] = [];
  const seen = new Set<string>();
  const pushRef = (n: Node, chrome = false) => {
    if (!n.ref_id) return;
    const acts = (n.available_actions ?? []).join(",");
    const tag = isScrollTarget(n) ? " SCROLL-TARGET" : "";
    const off = (n.states ?? []).includes("offscreen") ? " (offscreen)" : "";
    const line = `${n.ref_id} | ${n.role}${tag}${off} | "${clean(n.name ?? "")}" | ${acts}${chrome ? " | chrome" : ""}`;
    if (seen.has(line)) return;
    seen.add(line);
    interactive.push(line);
  };
  for (const d of docs) for (const n of walk(d)) pushRef(n);
  // chrome: combobox/entry (url bar) + named back/reload buttons outside menus
  for (const n of walk(tree)) {
    if (!n.ref_id) continue;
    const name = n.name ?? "";
    if ((n.role === "combobox" || n.role === "entry") && INTERESTING_CHROME.test(name)) pushRef(n, true);
    else if (n.role === "button" && /back|reload|forward/i.test(name)) pushRef(n, true);
  }
  lines.push("INTERACTIVE:");
  lines.push(...interactive.slice(0, 120));

  // PAGE TEXT — de-duplicated readable text from doc subtrees
  const texts: string[] = [];
  const seenText = new Set<string>();
  let textChars = 0;
  for (const d of docs) {
    for (const n of walk(d)) {
      const name = clean(n.name ?? "", 300);
      if (!name || name.length < 2) continue;
      if (!(TEXT_ROLES.has(n.role ?? "") || n.role === "link" || n.role === "heading")) continue;
      if (seenText.has(name)) continue;
      seenText.add(name);
      if (textChars + name.length > 4000) break;
      textChars += name.length;
      texts.push(name);
    }
    if (textChars > 4000) break;
  }
  if (texts.length) {
    lines.push("PAGE TEXT:");
    lines.push(...texts);
  }

  const out = lines.join("\n");
  return out.length > 9000 ? out.slice(0, 9000) + "\n…[truncated]" : out;
}
