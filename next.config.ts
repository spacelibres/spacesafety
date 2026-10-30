import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module; keep it out of the bundler.
  serverExternalPackages: ["better-sqlite3", "undici"],

  // The Cesium ion token is read in the browser, so it must be exposed as
  // `NEXT_PUBLIC_*`. Operators set the `SPACE_SAFETY_*` name — the convention
  // every other setting follows — and it is mirrored here rather than asking
  // them to remember a second, differently-prefixed variable.
  env: {
    NEXT_PUBLIC_SPACE_SAFETY_CESIUM_ION_TOKEN: process.env.SPACE_SAFETY_CESIUM_ION_TOKEN ?? "",
  },

  // The dev overlay's floating badge sits in the bottom-left corner, which is
  // where the language and appearance controls live. It covered them in every
  // screenshot and, worse, on a real screen. Errors still surface in the
  // terminal and as a full overlay.
  devIndicators: false,

  // The dev server is reached both as localhost and as this machine's LAN
  // address; without this Next warns on every request for /_next/*.
  allowedDevOrigins: ["127.0.0.1", "192.168.31.75"],

  // Downloaded meshes live under `data/models/`, outside `public/`, because they are
  // build artefacts rather than source: `data/` is gitignored and a checkout does not
  // have them. Rewriting keeps them servable without copying hundreds of megabytes
  // into `public/` or committing them.
  /**
   * Send the manifest link as a header as well as a tag.
   *
   * The layout renders `<link rel="manifest">` and React hoists it into `head`,
   * which is what Chrome requires — but Next's async metadata can also flush tags
   * into the body, and a manifest link outside `head` makes installability fail
   * with a bare `no-manifest` error. The HTTP `Link` header is honoured regardless
   * of document structure, so this is the belt to that braces.
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [{ key: "Link", value: '</manifest.webmanifest>; rel="manifest"' }],
      },
    ];
  },

  async rewrites() {
    return [{ source: "/models/:path*", destination: "/api/models/:path*" }];
  },
};

export default nextConfig;
