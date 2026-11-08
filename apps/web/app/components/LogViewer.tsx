"use client";
import * as React from "react";
import { ArrowDownToLine } from "lucide-react";
import { cn } from "./utils";

export type LogLevel = "debug" | "info" | "warn" | "error" | "success";

const levelText: Record<LogLevel, string> = {
  debug: "text-neutral-500",
  info: "text-sky-400",
  warn: "text-amber-400",
  error: "text-red-400",
  success: "text-emerald-400",
};
const levelLabel: Record<LogLevel, string> = {
  debug: "DBG", info: "INF", warn: "WRN", error: "ERR", success: "OK ",
};
export const LEVELS: LogLevel[] = ["debug", "info", "warn", "error", "success"];

export function LogViewer({ follow = true, className, children, ...props }: React.ComponentProps<"div"> & { follow?: boolean }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const pinned = React.useRef(true);
  const onScroll = () => {
    const el = ref.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };
  React.useEffect(() => { if (follow) pinned.current = true; }, [follow]);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (el && follow && pinned.current) el.scrollTop = el.scrollHeight;
  });
  return (
    <div ref={ref} onScroll={onScroll}
      className={cn("overflow-auto rounded-lg border border-neutral-800 bg-neutral-900 p-3 font-mono text-xs leading-relaxed", className)}
      {...props}>{children}</div>
  );
}

export function LogLine({ level = "info", time, source, className, children, ...props }:
  React.ComponentProps<"div"> & { level?: LogLevel; time?: React.ReactNode; source?: React.ReactNode }) {
  return (
    <div data-level={level} className={cn("flex gap-2 px-1 py-0.5 break-words whitespace-pre-wrap hover:bg-neutral-800/50", className)} {...props}>
      {time && <span className="shrink-0 text-neutral-600 tabular-nums">{time}</span>}
      <span className={cn("shrink-0 w-7 font-semibold", levelText[level])}>{levelLabel[level]}</span>
      {source && <span className="shrink-0 text-neutral-500">[{source}]</span>}
      <span className="min-w-0">{children}</span>
    </div>
  );
}

export function LogToolbar({ follow, onFollow, counts, active, onToggle }: {
  follow: boolean; onFollow: (v: boolean) => void;
  counts: Record<LogLevel, number>; active: Set<LogLevel>; onToggle: (l: LogLevel) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 mb-2 text-xs">
      <button onClick={() => onFollow(!follow)} className={cn(
        "flex items-center gap-1 px-2 py-1 rounded border",
        follow ? "border-emerald-700 text-emerald-300" : "border-neutral-700 text-neutral-400")}>
        <ArrowDownToLine size={12} /> Follow
      </button>
      {LEVELS.map((l) => (
        <button key={l} onClick={() => onToggle(l)} className={cn(
          "px-2 py-1 rounded border",
          active.has(l) ? cn("border-neutral-600", levelText[l]) : "border-neutral-800 text-neutral-600")}>
          {levelLabel[l]} {counts[l] > 0 && <span className="ml-1 text-neutral-500">{counts[l]}</span>}
        </button>
      ))}
    </div>
  );
}
