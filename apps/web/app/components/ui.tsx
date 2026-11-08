import { cn } from "./utils";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("rounded-xl border border-neutral-800 bg-neutral-900/50 p-5", className)}>{children}</div>;
}

export function Button({ variant = "secondary", className, ...p }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "violet" }) {
  return <button {...p} className={cn(
    "rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors disabled:opacity-40",
    variant === "primary" && "bg-emerald-600 text-white hover:bg-emerald-500",
    variant === "secondary" && "border border-neutral-700 text-neutral-200 hover:bg-neutral-800",
    variant === "violet" && "bg-violet-700 text-white hover:bg-violet-600",
    className)} />;
}

export function Input({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...p} className={cn(
    "w-full bg-neutral-900 border border-neutral-800 rounded-md px-3 py-2 text-[13px]",
    "placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none", className)} />;
}

export function Chip({ checked, onChange, children }: {
  checked: boolean; onChange: (v: boolean) => void; children: ReactNode;
}) {
  return <button type="button" onClick={() => onChange(!checked)} className={cn(
    "px-2.5 py-1 rounded-full border text-xs transition-colors",
    checked ? "border-emerald-700 bg-emerald-950 text-emerald-300" : "border-neutral-800 text-neutral-500 hover:border-neutral-600")}>
    {children}
  </button>;
}
