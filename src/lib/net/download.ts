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
}

export interface DownloadResult {
  body: Buffer;
  status: number;
  headers: Headers;
  /** True when the caller's completeness predicate accepted the body. */
  complete: boolean;
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
  const { timeoutMs = 300_000, retries = 3, signal, headers = {} } = opts;
  let last: DownloadResult | null = null;
  let lastError: string | null = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, {
        method: "GET",
        signal: signal ?? AbortSignal.timeout(timeoutMs),
        // No `Range` header: see the note above. `accept-encoding` is left to the
        // runtime, which negotiates and decompresses transparently.
        headers: {
          "user-agent": BROWSER_USER_AGENT,
          accept: "text/html,application/xhtml+xml,text/plain,*/*",
          acceptLanguage: "en-US,en;q=0.9",
          ...headers,
        },
      });

      if (!res.ok) {
        const retryable = res.status >= 500 || res.status === 429;
        last = {
          body: Buffer.alloc(0),
          status: res.status,
          headers: res.headers,
          complete: false,
        };
        if (!retryable || attempt === retries) return last;
        await sleep(500 * (attempt + 1));
        continue;
      }

      const body = Buffer.from(await res.arrayBuffer());
      const complete = isComplete(body, res.headers);
      last = { body, status: res.status, headers: res.headers, complete };
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
