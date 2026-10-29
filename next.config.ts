import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module; keep it out of the bundler.
  serverExternalPackages: ["better-sqlite3", "undici"],

  // The dev overlay's floating badge sits in the bottom-left corner, which is
  // where the language and appearance controls live. It covered them in every
  // screenshot and, worse, on a real screen. Errors still surface in the
  // terminal and as a full overlay.
  devIndicators: false,
};

export default nextConfig;
