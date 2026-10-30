/**
 * Service worker — the piece that makes this an installable app.
 *
 * Chrome will not offer "install to desktop" unless a service worker with a
 * `fetch` handler is registered and controlling the scope, so this exists for the
 * install prompt first and for offline resilience second.
 *
 * ## Strategy
 *
 * - **Navigations**: network first, falling back to the cached shell when the
 *   network fails. A cache-first page would serve yesterday's catalogue numbers,
 *   which for this product is a data-integrity problem, not a performance one.
 * - **Static assets** (`/_next/static/*`, `/vi/*`, `/pwa/*`, fonts, images):
 *   cache first, because their URLs are content-hashed and never change.
 * - **Everything else** (`/api/*` in particular): straight to the network. An API
 *   response is data; caching it would answer a question the reader did not ask.
 *
 * Bump `VERSION` on any change to this file — the `activate` handler deletes the
 * previous caches, which is what makes a stale worker harmless.
 */

const VERSION = "v1";
const STATIC_CACHE = `spacesafety-static-${VERSION}`;
const SHELL_CACHE = `spacesafety-shell-${VERSION}`;

/** Enough to render the shell when the network is gone. */
const SHELL_URLS = ["/", "/manifest.webmanifest", "/vi/icon-primary-dark.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_URLS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => !key.endsWith(VERSION))
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function isStatic(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/vi/") ||
    url.pathname.startsWith("/pwa/") ||
    url.pathname.startsWith("/cesium/") ||
    /\.(?:css|js|woff2?|png|jpe?g|svg|webp|glb)$/.test(url.pathname)
  );
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Data is never cached: a cached CDM or catalogue page would be a wrong answer.
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
          return response;
        })
        .catch(async () => (await caches.match(request)) ?? (await caches.match("/")) ?? Response.error()),
    );
    return;
  }

  if (!isStatic(url)) return;

  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ??
        fetch(request).then((response) => {
          const copy = response.clone();
          caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
          return response;
        }),
    ),
  );
});
