"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

/** Navigation items, matching the official sidebar (docs/UI-SPEC.md). */
const NAV = [
  { href: "/", label: "Home", icon: "home" },
  { href: "/docs", label: "Docs", icon: "docs" },
  { href: "/operators", label: "Operators", icon: "people" },
  { href: "/objects", label: "Objects", icon: "satellite" },
  { href: "/trajectories", label: "Trajectories", icon: "orbit" },
  { href: "/conjunctions", label: "Conjunctions", icon: "alert" },
  { href: "/keys", label: "Keys", icon: "key" },
] as const;

const ICONS: Record<string, string> = {
  home: "M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  docs: "M4 3h10l6 6v12H4zM14 3v6h6",
  people:
    "M8 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2 21c0-3.5 2.7-6 6-6s6 2.5 6 6M17 8a3 3 0 1 1 0 6M18 15c2.5.6 4 2.6 4 5",
  satellite:
    "M12 3l3 3-2 2 3 3 2-2 3 3-5 5-3-3-2 2-3-3 2-2-3-3zM4 20l3-3M3 21l1-1",
  orbit:
    "M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0M4 12c0-4.4 3.6-8 8-8M20 12c0 4.4-3.6 8-8 8",
  alert: "M12 3l9 16H3zM12 9v5M12 17v.5",
  key: "M14 7a4 4 0 1 1-3.5 6L4 19.5V21H2v-3l8-7A4 4 0 0 1 14 7z",
};

export function Icon({ name }: { name: string }) {
  return (
    <svg
      className="nav-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICONS[name] ?? ICONS.home} />
    </svg>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const [clock, setClock] = useState("");

  useEffect(() => {
    const tick = () => setClock(formatUtc(new Date()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // The environment banner is a safety feature of the official UI: it must be
  // impossible to confuse staging with production.
  const env = process.env.NEXT_PUBLIC_SPACE_SAFETY_ENV ?? "staging";
  const showBanner = env !== "production";

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">Space Safety</div>
      {showBanner && <div className="sidebar-env">{env}</div>}
      <div className="sidebar-clock">{clock}</div>

      <div className="sidebar-search">
        <input placeholder="Search (/)" aria-label="Search" />
      </div>

      <nav className="sidebar-nav">
        {NAV.map((item) => {
          const active =
            item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`nav-item${active ? " active" : ""}`}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}

export function Topbar({
  section,
  entityId,
}: {
  section: string;
  entityId?: string | null;
}) {
  return (
    <div className="topbar">
      <div className="breadcrumb">
        <Icon name="docs" />
        <span>{section}</span>
      </div>
      <div className="topbar-spacer" />
      {entityId && <div className="topbar-id">{entityId}</div>}
    </div>
  );
}

function formatUtc(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`
  );
}
