import "./globals.css";
import type { ReactNode } from "react";
import Sidebar from "./components/Sidebar";

export const metadata = { title: "MIMK", description: "Agent investigations" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="bg-neutral-950 text-neutral-100 min-h-screen">
        <div className="flex">
          <Sidebar />
          <main className="flex-1 min-w-0 p-6">{children}</main>
        </div>
      </body>
    </html>
  );
}
