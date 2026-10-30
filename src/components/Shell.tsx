"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { useTranslator } from "@/lib/i18n/client";
import { LOGO_MARKS } from "@/lib/vi/logo-marks";
import type { ThemeMode } from "@/lib/vi/theme-bridge";

import { PreferenceDock } from "./PreferenceDock";

/**
 * Navigation items.
 *
 * `labelKey` rather than a label: the sidebar is rendered on every page, so it must
 * not carry its own copy of the strings.
 *
 * An entry is either a link or a group. A group exists where several pages are
 * facets of one thing — the catalogue list, category browser, statistics and the 3D
 * model library are all "satellite catalogue", and listing them as separate
 * top-level items made the sidebar read as four unrelated tools.
 */
interface NavLink {
  href: string;
  labelKey: string;
  icon: string;
}

interface NavGroup {
  labelKey: string;
  icon: string;
  children: NavLink[];
}

type NavEntry = NavLink | NavGroup;

const isGroup = (e: NavEntry): e is NavGroup => "children" in e;

const NAV: NavEntry[] = [
  { href: "/", labelKey: "nav.home", icon: "home" },
  { href: "/docs", labelKey: "nav.docs", icon: "docs" },
  { href: "/operators", labelKey: "nav.operators", icon: "people" },
  {
    labelKey: "nav.catalogueGroup",
    icon: "satellite",
    children: [
      { href: "/catalogue", labelKey: "nav.catalogue", icon: "satellite" },
      { href: "/browse", labelKey: "nav.browse", icon: "satellite" },
      { href: "/statistics", labelKey: "nav.statistics", icon: "docs" },
      { href: "/models", labelKey: "nav.models", icon: "satellite" },
      { href: "/objects", labelKey: "nav.objects", icon: "satellite" },
    ],
  },
  { href: "/trajectories", labelKey: "nav.trajectories", icon: "orbit" },
  { href: "/conjunctions", labelKey: "nav.conjunctions", icon: "alert" },
  { href: "/screening/socrates", labelKey: "nav.socrates", icon: "alert" },
  { href: "/reentry", labelKey: "nav.reentry", icon: "descent" },
  { href: "/environment", labelKey: "nav.environment", icon: "globe" },
  { href: "/launches", labelKey: "nav.launches", icon: "launch" },
  { href: "/keys", labelKey: "nav.keys", icon: "key" },
  // The official sidebar ends with these two; keeping the order lets a reader
  // compare this layout with the reference screenshots entry for entry.
  { href: "/users", labelKey: "nav.users", icon: "people" },
  { href: "/feedback", labelKey: "nav.feedback", icon: "docs" },
];

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
  descent: "M4 5h9M4 9h7M20 4l-9 9M14 4h6v6M6 20l3-3M4 22l1-1",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M3 12h18M12 3c3 3 4.5 6 4.5 9s-1.5 6-4.5 9c-3-3-4.5-6-4.5-9s1.5-6 4.5-9",
  launch: "M12 2.5c2 2.5 3.2 5.8 3.2 9.2L12 15l-3.2-3.3c0-3.4 1.2-6.7 3.2-9.2zM8.8 11.7L6 15l2.6 1.4M15.2 11.7L18 15l-2.6 1.4M12 15v4.5",
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

export function Sidebar({ theme }: { theme: ThemeMode }) {
  const pathname = usePathname();
  const t = useTranslator();
  const [clock, setClock] = useState("");

  /**
   * Groups the user has opened by clicking, keyed by `labelKey`.
   *
   * Kept as a set of keys rather than one "which group is open" value so that a
   * future second group can be open at the same time without rewriting this.
   */
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(new Set());
  const toggleGroup = (key: string) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

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
      {/*
        The VI is explicit that the mark is a vector master, not lettering
        (§编排: 网站导航 uses the horizontal master; "标志 … 不得用文字代替").
        This rendered `{t.t("app.name")}` — the CSS beside it had been written
        for an <img> the whole time, which is how the logo ended up styled and
        never mounted.

        The compact breakpoint swaps to the icon master rather than shrinking
        the horizontal mark below the VI's 240 px minimum (24–32 px is where the
        VI warns the tips and thin gaps degrade).

        Rendered inline rather than as an `<img>`: the mark's two colour roles are
        bound to `var(--color-planet)` / `var(--color-primary)`, so one artifact
        follows both the theme and whichever colour scheme the reader picked —
        the VI requires the SVG mark to move with the rest of the page.
      */}
      <div className="sidebar-brand">
        <span
          className="brand-mark brand-mark-wide"
          role="img"
          aria-label={t.t("app.name")}
          dangerouslySetInnerHTML={{ __html: LOGO_MARKS.horizontal }}
        />
        <span
          className="brand-mark brand-mark-compact"
          role="img"
          aria-label={t.t("app.name")}
          dangerouslySetInnerHTML={{ __html: LOGO_MARKS.icon }}
        />
      </div>
      {showBanner && <div className="sidebar-env">{env}</div>}
      <div className="sidebar-clock">{clock}</div>

      <div className="sidebar-search">
        <input
          placeholder={t.t("nav.search")}
          aria-label={t.t("nav.searchLabel")}
        />
      </div>

      <nav className="sidebar-nav" aria-label={t.t("a11y.sidebar")}>
        {NAV.map((item) => {
          if (!isGroup(item)) {
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
          }

          // Open when the current route is one of the children, or when the user has
          // clicked the header. Path state alone was not enough: from the home page
          // nothing under the group was reachable, because the header was a plain
          // <div> and the list it would expand only exists once you are already
          // inside the section.
          const groupActive = item.children.some((c) => pathname.startsWith(c.href));
          const expanded = groupActive || openGroups.has(item.labelKey);
          return (
            <div key={item.labelKey} className="nav-group">
              <button
                type="button"
                className={`nav-item nav-group-title${groupActive ? " active" : ""}`}
                aria-expanded={expanded}
                aria-controls={`nav-group-${item.icon}`}
                onClick={() => toggleGroup(item.labelKey)}
              >
                <Icon name={item.icon} />
                <span>{t.t(item.labelKey)}</span>
                <svg
                  className={`nav-chevron${expanded ? " open" : ""}`}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </button>
              <div
                id={`nav-group-${item.icon}`}
                className={`nav-sub${expanded ? " open" : ""}`}
              >
                {item.children.map((child) => {
                  const active =
                    child.href === "/"
                      ? pathname === "/"
                      : pathname === child.href || pathname.startsWith(`${child.href}/`);
                  return (
                    <Link
                      key={child.href}
                      href={child.href}
                      className={`nav-item nav-sub-item${active ? " active" : ""}`}
                    >
                      <span>{t.t(child.labelKey)}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>

      <PreferenceDock />
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
