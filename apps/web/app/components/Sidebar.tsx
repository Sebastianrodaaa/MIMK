"use client";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { MessageSquare, SquarePen, Globe2, PanelLeftClose, PanelLeftOpen, Activity, Trash2, Check } from "lucide-react";
import { cn } from "./utils";
import { ORCH } from "../lib";
import { useChats, newChat, selectChat, deleteChat, type Session } from "../chats";

const NAV = [
  { href: "/", title: "Chat", icon: MessageSquare },
  { href: "/world", title: "Pixel World", icon: Globe2 },
];

const DAY = 24 * 60 * 60 * 1000;
function groupOf(updatedAt: number): "Today" | "Previous 7 days" | "Older" {
  const age = Date.now() - updatedAt;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (updatedAt >= today.getTime()) return "Today";
  if (age < 7 * DAY) return "Previous 7 days";
  return "Older";
}

function SessionItem({ s, active }: { s: Session; active: boolean }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="group relative">
      <button
        onClick={() => { selectChat(s.id); router.push("/"); }}
        className={cn(
          "w-full truncate rounded-lg px-2 py-1.5 text-left text-xs transition-colors",
          active ? "bg-neutral-800 text-neutral-100" : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
        )}
      >
        {s.title}
      </button>
      {confirming ? (
        <span className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded bg-neutral-900 px-1">
          <span className="text-[10px] text-neutral-400">Delete?</span>
          <button
            aria-label="Confirm delete chat"
            onClick={() => deleteChat(s.id)}
            className="p-0.5 text-red-400 hover:text-red-300"
          >
            <Check size={11} />
          </button>
          <button
            aria-label="Cancel delete"
            onClick={() => setConfirming(false)}
            className="p-0.5 text-neutral-400 hover:text-neutral-200"
          >
            ×
          </button>
        </span>
      ) : (
        <button
          aria-label="Delete chat"
          onClick={() => setConfirming(true)}
          className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-neutral-500 opacity-0 transition-opacity hover:text-red-300 group-hover:opacity-100 group-focus-within:opacity-100"
        >
          <Trash2 size={11} />
        </button>
      )}
    </div>
  );
}

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(true);
  const [status, setStatus] = useState<any>();
  const { sessions, activeId } = useChats();

  useEffect(() => {
    const load = () => fetch(`${ORCH}/status`).then((r) => r.json()).then(setStatus).catch(() => {});
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);

  const groups: { label: string; items: Session[] }[] = [];
  for (const s of sessions) {
    const label = groupOf(s.updatedAt);
    const g = groups.find((g) => g.label === label) ?? groups[groups.push({ label, items: [] }) - 1];
    g.items.push(s);
  }

  return (
    <aside className={cn(
      "h-screen sticky top-0 flex flex-col border-r border-neutral-800 bg-neutral-950 transition-all",
      open ? "w-52" : "w-12"
    )}>
      <div className="flex items-center justify-between px-3 py-4">
        {open && <span className="font-semibold tracking-tight">MIMK</span>}
        <button onClick={() => setOpen(!open)} className="text-neutral-400 hover:text-neutral-100" aria-label="Toggle sidebar">
          {open ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
        </button>
      </div>
      <nav className="px-2 space-y-1">
        {NAV.map(({ href, title, icon: Icon }) => (
          <a key={href} href={href} className={cn(
            "flex items-center gap-3 px-2 py-2 rounded-lg text-sm transition-colors",
            pathname === href ? "bg-neutral-800 text-neutral-100" : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
          )}>
            <Icon size={16} className="shrink-0" />
            {open && title}
          </a>
        ))}
      </nav>
      <div className="px-2 pt-2">
        <button
          onClick={() => { newChat(); router.push("/"); }}
          aria-label="New chat"
          className={cn(
            "flex w-full items-center gap-3 rounded-lg border border-neutral-800 px-2 py-2 text-sm text-neutral-300 transition-colors hover:bg-neutral-900",
            !open && "justify-center"
          )}
        >
          <SquarePen size={16} className="shrink-0" />
          {open && "New chat"}
        </button>
      </div>
      {open && (
        <div className="flex-1 min-h-0 overflow-y-auto px-2 pt-3">
          <p className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-neutral-600">Recent</p>
          {groups.map((g) => (
            <div key={g.label} className="mb-2">
              <p className="px-2 pb-0.5 text-[10px] text-neutral-600">{g.label}</p>
              <div className="space-y-0.5">
                {g.items.map((s) => (
                  <SessionItem key={s.id} s={s} active={pathname === "/" && s.id === activeId} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {open && status && (
        <div className="px-3 py-3 border-t border-neutral-800 space-y-1.5 text-[10px]">
          <div className="flex items-center gap-1 text-neutral-500 mb-1"><Activity size={10} /> status</div>
          <div className="flex flex-wrap gap-1">
            <span className={cn("px-1.5 py-0.5 rounded", status.modelKey === "set" ? "bg-emerald-900 text-emerald-300" : "bg-neutral-800 text-neutral-400")}>
              {status.modelKey === "set" ? "LIVE" : "OFFLINE"}
            </span>
            <span className="px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-400">{status.runBackend}</span>
            <span className="px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-400">{status.sim}</span>
          </div>
        </div>
      )}
      {!open && <div className="flex-1" />}
    </aside>
  );
}
