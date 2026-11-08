import { cn } from "./utils";

const V = {
  online: ["bg-emerald-400", "text-emerald-300", true],
  info: ["bg-sky-400", "text-sky-300", true],
  error: ["bg-red-400", "text-red-300", false],
  warning: ["bg-amber-400", "text-amber-300", false],
  idle: ["bg-neutral-500", "text-neutral-400", false],
} as const;
export type StatusVariant = keyof typeof V;

export default function StatusPill({ variant, children, className }: {
  variant: StatusVariant; children: React.ReactNode; className?: string;
}) {
  const [dot, text, pulse] = V[variant];
  return (
    <span className={cn("inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-neutral-800 bg-neutral-900 text-[11px]", text, className)}>
      <span className={cn("w-1.5 h-1.5 rounded-full", dot, pulse && "animate-pulse")} />
      {children}
    </span>
  );
}
