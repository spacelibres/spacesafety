/**
 * Outbound HTTP for vendor data.
 *
 * ## What actually works against starlink.com
 *
 * The endpoints require nothing special: a plain `GET` with a browser
 * `User-Agent` and `Accept-Encoding` returns the complete file. Measured on
 * `STARLINK-35000.txt`: 5 026 606 bytes, ending in `TRAJ_STOP` / `MAN_STOP`.
 *
 * Two things must be avoided, both of which were tried here and both of which
 * produce *silently truncated* data:
 *
 *   1. **`Range` requests.** Asking for `bytes=0-999999999` returns 206 with a
 *      prefix of the file and no error — the response looks like a successful
 *      download of a shorter orbit. Plain GET is the only reliable form.
 *   2. **`Range`-probe length checks.** `content-length` and `content-range` on
 *      this host disagree with the real size (76 725 declared for an 823 468-byte
 *      manifest), so the declared length cannot be used to detect truncation.
 *
 * Completeness is therefore decided by the *format's own terminator*
 * (`TRAJ_STOP`, or a well-formed final line), never by a header.
 *
 * Node's global `fetch` is used rather than a proxy agent: the direct route is
 * what the browser uses and is the route that works here.
 */

export interface DownloadOptions {
  timeoutMs?: number;
  retries?: number;
  signal?: AbortSignal;
  /** Header overrides, e.g. Space-Track's session cookie. */
  headers?: Record<string, string>;
  /**
   * Validators from the previous capture.
   *
   * Sending these turns the poll into a conditional request: an unchanged file
   * comes back as `304 Not Modified` with no body, which is the difference
   * between re-downloading 552 MB a day and downloading only what moved.
   */
  conditional?: { etag?: string | null; lastModified?: string | null };
}

export interface DownloadResult {
  body: Buffer;
  status: number;
  headers: Headers;
  /** True when the caller's completeness predicate accepted the body. */
  complete: boolean;
  /** True when the server answered 304 to a conditional request. */
  notModified: boolean;
  /** Validators to store for the next poll. */
  etag: string | null;
  lastModified: string | null;
}

/** Identifies as a normal browser. The endpoints serve the files to browsers. */
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Safari/537.36";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GET a URL, retrying until `isComplete` accepts the body.
 *
 * A short body is retried because the connection can close early; the last body
 * is returned with `complete: false` once retries are exhausted, so callers can
 * choose between failing loudly and degrading.
 */
export async function download(
  url: string,
  isComplete: (body: Buffer, headers: Headers) => boolean,
  opts: DownloadOptions = {},
): Promise<DownloadResult> {
  const { timeoutMs = 300_000, retries = 3, signal, headers = {}, conditional } = opts;
  let last: DownloadResult | null = null;
  let lastError: string | null = null;

  // A conditional request is only sent when we hold a validator from a previous
  // capture. Without one the server has nothing to compare against and would
  // send the whole body anyway.
  const conditionalHeaders: Record<string, string> = {};
  if (conditional?.etag) conditionalHeaders["if-none-match"] = conditional.etag;
  if (conditional?.lastModified) {
    conditionalHeaders["if-modified-since"] = conditional.lastModified;
  }

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, {
        method: "GET",
        signal: signal ?? AbortSignal.timeout(timeoutMs),
        // No `Range` header: see the note above.
        //
        // `accept-encoding` is set explicitly rather than left to the runtime.
        // undici negotiates brotli by default, and on the largest body it is the
        // *worse* choice — measured on `/api/entity/omm/json` (30.37 MB raw):
        //
        //   identity  30.37 MB   7.2 s
        //   gzip       7.23 MB   1.3 s   ← chosen
        //   brotli     8.59 MB   2.5 s
        //
        // So always advertise gzip first. Whatever the host returns is decompressed
        // by undici before this function sees it; the body length the caller
        // measures is always the decompressed one.
        headers: {
          "user-agent": BROWSER_USER_AGENT,
          accept: "text/html,application/xhtml+xml,text/plain,*/*",
          acceptLanguage: "en-US,en;q=0.9",
          "accept-encoding": "gzip, deflate",
          ...conditionalHeaders,
          ...headers,
        },
      });

      // 304 carries no body; `res.ok` is false for it, so it is handled first.
      // This is the whole point of the conditional request: the file did not
      // change, so nothing is transferred and nothing downstream needs to run.
      if (res.status === 304) {
        return {
          body: Buffer.alloc(0),
          status: 304,
          headers: res.headers,
          complete: true,
          notModified: true,
          etag: res.headers.get("etag") ?? conditional?.etag ?? null,
          lastModified:
            res.headers.get("last-modified") ?? conditional?.lastModified ?? null,
        };
      }

      if (!res.ok) {
        const retryable = res.status >= 500 || res.status === 429;
        last = {
          body: Buffer.alloc(0),
          status: res.status,
          headers: res.headers,
          complete: false,
          notModified: false,
          etag: null,
          lastModified: null,
        };
        if (!retryable || attempt === retries) return last;
        await sleep(500 * (attempt + 1));
        continue;
      }

      const body = Buffer.from(await res.arrayBuffer());
      const complete = isComplete(body, res.headers);
      last = {
        body,
        status: res.status,
        headers: res.headers,
        complete,
        notModified: false,
        etag: res.headers.get("etag") ?? null,
        lastModified: res.headers.get("last-modified") ?? null,
      };
      if (complete) return last;
      lastError = `${body.length} bytes (incomplete)`;
      await sleep(500 * (attempt + 1));
    } catch (err) {
      lastError = (err as Error).message;
      last = {
        body: Buffer.alloc(0),
        status: 0,
        headers: new Headers(),
        complete: false,
        notModified: false,
        etag: null,
        lastModified: null,
      };
      if (attempt === retries) {
        throw new Error(
          `download failed for ${url} after ${attempt + 1} attempt(s): ${lastError}`,
        );
      }
      await sleep(500 * (attempt + 1));
    }
  }

  return last!;
}

/** Fetch text. Throws when the body never arrived complete. */
export async function downloadText(
  url: string,
  isComplete: (body: Buffer, headers: Headers) => boolean,
  opts: DownloadOptions = {},
): Promise<{ text: string; complete: boolean; status: number }> {
  const result = await download(url, isComplete, opts);
  if (result.status === 0) {
    throw new Error(`download failed for ${url}`);
  }
  if (result.status >= 400) {
    throw new Error(`HTTP ${result.status} for ${url}`);
  }
  return { text: result.body.toString("utf8"), complete: result.complete, status: result.status };
}

/**
 * Completeness for a plain-text vendor file.
 *
 * Both the manifest and the OCM/ITC bodies end with a line that is not cut
 * mid-token, so the marker is the evidence — never `content-length`.
 */
export function looksCompleteText(
  marker: string | RegExp,
  opts: { minBytes?: number } = {},
): (body: Buffer, headers: Headers) => boolean {
  const min = opts.minBytes ?? 1;
  return (body) => {
    if (!body || body.length < min) return false;
    const head = body.subarray(0, 1).toString();
    if (head === "<" || head === "{") return false;
    const tail = body.subarray(Math.max(0, body.length - 8192)).toString("utf8");
    return typeof marker === "string" ? tail.includes(marker) : marker.test(tail);
  };
}
