"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { LanguageSwitcher, useTranslator } from "@/lib/i18n/client";

/**
 * Navigation items, matching the official sidebar (docs/UI-SPEC.md).
 *
 * `labelKey` rather than a label: the sidebar is rendered on every page, so it
 * must not carry its own copy of the strings.
 */
const NAV = [
  { href: "/", labelKey: "nav.home", icon: "home" },
  { href: "/docs", labelKey: "nav.docs", icon: "docs" },
  { href: "/operators", labelKey: "nav.operators", icon: "people" },
  { href: "/objects", labelKey: "nav.objects", icon: "satellite" },
  { href: "/catalogue", labelKey: "nav.catalogue", icon: "satellite" },
  { href: "/browse", labelKey: "nav.browse", icon: "satellite" },
  { href: "/models", labelKey: "nav.models", icon: "satellite" },
  { href: "/trajectories", labelKey: "nav.trajectories", icon: "orbit" },
  { href: "/conjunctions", labelKey: "nav.conjunctions", icon: "alert" },
  { href: "/screening/socrates", labelKey: "nav.socrates", icon: "alert" },
  { href: "/keys", labelKey: "nav.keys", icon: "key" },
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
  const t = useTranslator();
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
      <div className="sidebar-brand">{t.t("app.name")}</div>
      {showBanner && <div className="sidebar-env">{env}</div>}
      <div className="sidebar-clock">{clock}</div>

      <div className="sidebar-search">
        <input
          placeholder={t.t("nav.search")}
          aria-label={t.t("nav.searchLabel")}
        />
      </div>

      <LanguageSwitcher />

      <nav className="sidebar-nav" aria-label={t.t("a11y.sidebar")}>
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
              <span>{t.t(item.labelKey)}</span>
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
