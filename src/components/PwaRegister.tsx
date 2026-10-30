"use client";

import { useEffect } from "react";

/**
 * Register the service worker.
 *
 * Chrome only offers "install to desktop" when a service worker with a `fetch`
 * handler controls the page, so this component is what turns the site into an
 * installable app. It renders nothing.
 *
 * Registration is skipped outside production builds and outside a secure context:
 * a dev server restarts constantly and would leave stale caches behind, and
 * `serviceWorker` is unavailable on plain HTTP for anything but localhost, so
 * guarding keeps the dev experience honest instead of failing silently.
 */
export function PwaRegister() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    if (!window.isSecureContext) return;
    if (process.env.NODE_ENV !== "production") return;

    const register = () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((err: unknown) => {
        // A failed registration must not break the page; log it once and move on.
        console.warn("[space-safety] service worker registration failed:", err);
      });
    };

    // Registering after `load` keeps the worker off the critical path.
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);

  return null;
}
