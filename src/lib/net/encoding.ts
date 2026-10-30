import * as zlib from "node:zlib";

/**
 * Content encoding for every outbound request.
 *
 * ## Why this is one module rather than a header on each call site
 *
 * The catalogue bodies are the largest thing this project moves: Spacebook's
 * `/api/entity/omm/json` is 30.37 MB uncompressed, Space-Track's `satcat` and
 * KeepTrack's `/sats` are in the same class, and DISCOS pages are JSON that
 * compresses about five-fold. Leaving `accept-encoding` to the runtime looked
 * harmless, and it was wrong in two ways:
 *
 *   1. **undici negotiates brotli, which is the worse choice here.** Measured on
 *      the 30.37 MB OMM body: gzip transfers 7.23 MB in 1.3 s, brotli transfers
 *      8.59 MB in 2.5 s. Brotli wins on assets a CDN pre-compresses once; it
 *      loses on a large single-shot body where decode time is on the critical
 *      path.
 *   2. **The hand-rolled SOCKS5 transport never asked at all**, and it speaks
 *      raw `http.request`, so it would have received gzip bytes and handed them
 *      to a completeness check that expects text. Advertising an encoding there
 *      without decoding would be worse than not advertising one.
 *
 * So: one constant every call site uses, and one decoder for the paths that do
 * not get undici's automatic decoding.
 *
 * These vendors do **not** send `ETag` / `Last-Modified` (measured 2026-10-30),
 * so compression is the only lever that actually reduces transferred bytes.
 * See `docs/DATA-SOURCES.md`.
 */

/**
 * What every outbound request advertises.
 *
 * gzip before deflate, and no brotli: see the measurement above.
 */
export const ACCEPT_ENCODING = "gzip, deflate";

/** Encodings this module can decode. */
const SUPPORTED = new Set(["", "identity", "gzip", "x-gzip", "deflate", "br"]);

/**
 * Undo a `content-encoding` on a buffer that the runtime did **not** decode.
 *
 * Only needed on the raw-socket paths; `fetch` callers get a decoded body and
 * must not call this (decoding twice is a `Z_DATA_ERROR`, which is at least a
 * loud failure rather than silent corruption).
 *
 * @throws when the encoding is one this build cannot undo — returning the still
 *   compressed bytes would push gzip into a text pipeline, and the failure would
 *   surface much later as "incomplete body" with no clue why.
 */
export function decodeBody(raw: Buffer, contentEncoding: string | null | undefined): Buffer {
  const encoding = (contentEncoding ?? "").trim().toLowerCase();
  if (!SUPPORTED.has(encoding)) {
    throw new Error(
      `unsupported content-encoding "${contentEncoding}": refused to hand back ` +
        `${raw.length} still-encoded bytes`,
    );
  }
  // `zlibSync` is deliberately avoided: brotli expands 30 MB into memory in one
  // shot and the callers here already hold the buffer.
  switch (encoding) {
    case "":
    case "identity":
      return raw;
    case "gzip":
    case "x-gzip":
      return zlib.gunzipSync(raw);
    case "br":
      return zlib.brotliDecompressSync(raw);
    case "deflate":
      // `deflate` is supposed to mean zlib-wrapped, but enough servers send raw
      // deflate that both have to be tried before declaring the body broken.
      try {
        return zlib.inflateSync(raw);
      } catch {
        return zlib.inflateRawSync(raw);
      }
  }
  /* c8 ignore next */
  return raw;
}
