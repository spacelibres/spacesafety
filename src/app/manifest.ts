import type { MetadataRoute } from "next";

import { ELECTRIC_ORBIT } from "@/lib/vi/palette";

/**
 * The web app manifest — what makes the browser offer "install to desktop".
 *
 * This is a metadata route rather than a file in `public/` so Next serves it at
 * the canonical `/manifest.webmanifest` with the right content type, and so the
 * colours come from the palette instead of being typed twice.
 *
 * Chrome is strict about where the link lives: a `<link rel="manifest">` that the
 * App Router's async metadata emits can land in the body, and Chrome then reports
 * `no-manifest` and never offers the install prompt. The link is therefore also
 * sent as an HTTP `Link` header (see `next.config.ts`), which Chrome accepts
 * regardless of where the document puts its tags.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Space Safety",
    short_name: "Space Safety",
    description: "Satellite orbit safety and conjunction assessment",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: ELECTRIC_ORBIT.deep,
    theme_color: ELECTRIC_ORBIT.deep,
    lang: "zh-CN",
    dir: "ltr",
    categories: ["productivity", "utilities"],
    icons: [
      { src: "/vi/icon-primary-dark.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/pwa/icon-192-any.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/pwa/icon-512-any.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/pwa/icon-192-maskable.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/pwa/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Catalogue", url: "/catalogue" },
      { name: "Conjunctions", url: "/conjunctions" },
      { name: "Objects", url: "/objects" },
    ],
  };
}
