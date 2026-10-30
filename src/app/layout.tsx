import type { Metadata } from "next";

import { PwaRegister } from "@/components/PwaRegister";
import { Sidebar } from "@/components/Shell";
import { I18nProvider } from "@/lib/i18n/client";
import { currentLocale, translator } from "@/lib/i18n/registry";
import { currentPalette, currentTheme } from "@/lib/vi/theme";
import { tokenCss } from "@/lib/vi/tokens";

import "cesium/Build/Cesium/Widgets/widgets.css";
import "./globals.css";

/**
 * Title and description come from the dictionary, so they follow the reader's
 * language instead of staying English on every page.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = translator(await currentLocale());
  const palette = await currentPalette();
  return {
    title: t.t("app.name"),
    description: `${t.t("app.tagline")} — space-safety.starlink.com replica`,
    // Installability comes from `src/app/manifest.ts` (served by the metadata
    // route) plus the service worker; the manifest link is additionally sent as an
    // HTTP `Link` header because Chrome ignores one that lands outside `<head>`.
    applicationName: t.t("app.name"),
    themeColor: [
      { media: "(prefers-color-scheme: dark)", color: palette.deep },
      { media: "(prefers-color-scheme: light)", color: palette.surface },
    ],
    appleWebApp: { capable: true, title: t.t("app.name"), statusBarStyle: "black-translucent" },
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Resolve the locale once here: `<html lang>` and the client provider must
  // agree, or screen readers and font selection pick the wrong language.
  const locale = await currentLocale();
  // Resolved on the server so the first paint already carries the right
  // palette; a browser-only switch would flash the wrong theme.
  const theme = await currentTheme();
  // The static stylesheet carries the default scheme. A reader who picked another
  // one gets the same generator's output injected here — the VI derives the whole
  // scheme from a single primary, so this is a token block, not sixteen choices.
  const palette = await currentPalette();
  const derivedTokens = palette.name === "01-electric-orbit" ? null : tokenCss(palette);

  return (
    <html lang={locale} data-theme={theme}>
      <body>
        {/*
          Rendered here rather than only in `generateMetadata` because that path is
          async: Next flushes the document shell first, and the metadata block — the
          manifest link included — can land in the body. Chrome ignores a manifest
          link outside `<head>`, so installability silently fails with `no-manifest`
          even though the manifest itself is fine. An element rendered in the tree is
          hoisted into the head by React.
        */}
        <link rel="manifest" href="/manifest.webmanifest" />
        <PwaRegister />
        {/* Placed first in <body> so it lands after the stylesheet links in
            document order and therefore wins the cascade. */}
        {derivedTokens ? (
          <style id="vi-palette-tokens" dangerouslySetInnerHTML={{ __html: derivedTokens }} />
        ) : null}
        <I18nProvider locale={locale}>
          <div className="app">
            <Sidebar theme={theme} />
            <div className="main">{children}</div>
          </div>
        </I18nProvider>
      </body>
    </html>
  );
}
