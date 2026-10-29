import type { Metadata } from "next";

import { Sidebar } from "@/components/Shell";

import "./globals.css";

export const metadata: Metadata = {
  title: "Space Eyes — Space Safety",
  description:
    "Satellite orbit safety and conjunction assessment, modelled on space-safety.starlink.com",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <div className="app">
          <Sidebar />
          <div className="main">{children}</div>
        </div>
      </body>
    </html>
  );
}
