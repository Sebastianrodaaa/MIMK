"use client";
import { useState } from "react";
import { ExternalLink } from "lucide-react";
import type { InstantFinding } from "../chats";

const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
const HANDLE_URL: Record<string, string> = {
  github: "https://github.com/", twitter: "https://x.com/", instagram: "https://instagram.com/",
  linkedin: "https://linkedin.com/in/", orcid: "https://orcid.org/", mastodon: "", website: "",
};

export default function InstantFindings({ instant }: { instant: InstantFinding[] }) {
  if (!instant?.length) return null;
  return (
    <div className="mt-2 space-y-2">
      {instant.map((r, i) => <Card key={i} r={r} />)}
    </div>
  );
}

function Card({ r }: { r: InstantFinding }) {
  const [open, setOpen] = useState(false);
  const facts = open ? r.facts : r.facts.slice(0, 6);
  const handles = Object.entries(r.handles ?? {});
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-xs font-medium text-neutral-200">Instant findings for {r.person}</h4>
        <span className="text-[10px] text-neutral-500">{(r.ms / 1000).toFixed(1)}s</span>
      </div>
      <ul className="mt-2 space-y-1">
        {facts.map((f, i) => (
          <li key={i} className="text-[11px] leading-snug text-neutral-300">
            {f.summary}
            <a href={f.sourceUrl} target="_blank" rel="noreferrer"
              className="ml-1 inline-flex items-center gap-0.5 text-[10px] text-neutral-500 hover:text-neutral-300">
              {host(f.sourceUrl)}<ExternalLink size={9} />
            </a>
          </li>
        ))}
      </ul>
      {r.facts.length > 6 && (
        <button onClick={() => setOpen(!open)} className="mt-1 text-[10px] text-neutral-500 hover:text-neutral-300">
          {open ? "show less" : `+${r.facts.length - 6} more`}
        </button>
      )}
      {handles.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {handles.map(([k, v]) => {
            const base = HANDLE_URL[k];
            const href = base ? base + v : v;
            return (
              <a key={k} href={href} target="_blank" rel="noreferrer"
                className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400 hover:text-neutral-200">
                {k}: {v}
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}
