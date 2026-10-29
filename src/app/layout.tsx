import type { Metadata } from "next";

import { Sidebar } from "@/components/Shell";
import { I18nProvider } from "@/lib/i18n/client";
import { currentLocale, translator } from "@/lib/i18n/registry";

import "./globals.css";

/**
 * Title and description come from the dictionary, so they follow the reader's
 * language instead of staying English on every page.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = translator(await currentLocale());
  return {
    title: t.t("app.name"),
    description: `${t.t("app.tagline")} — space-safety.starlink.com replica`,
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Resolve the locale once here: `<html lang>` and the client provider must
  // agree, or screen readers and font selection pick the wrong language.
  const locale = await currentLocale();

  return (
    <html lang={locale}>
      <body>
        <I18nProvider locale={locale}>
          <div className="app">
            <Sidebar />
            <div className="main">{children}</div>
          </div>
        </I18nProvider>
      </body>
    </html>
  );
}
