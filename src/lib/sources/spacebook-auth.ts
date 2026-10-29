/**
 * Spacebook authentication (Auth0, authorization-code + PKCE).
 *
 * ## Why this cannot be a username/password POST
 *
 * Spacebook delegates login to an Auth0 tenant
 * (`comspoc-spacebook.us.auth0.com`, client `o8A7Txz1uNaDrS7ICrOfFuOb7SXtE0fy`).
 * The tenant advertises several grants, but the public SPA client is configured
 * to allow only `authorization_code`. Both alternatives that would make a
 * headless login possible are refused:
 *
 *   password      → 403 unauthorized_client "Grant type 'password' not allowed"
 *   device_code   → 403 unauthorized_client, same reason
 *   client_credentials → 401 access_denied (it is a public client, no secret)
 *
 * So the password in `.env.local` is not used to mint a token directly. It is
 * there because it is the credential the human uses to approve the one browser
 * consent that produces a refresh token; after that the refresh token is what the
 * automated path uses, and it is valid for the tenant's refresh lifetime.
 *
 * ## What is actually gated
 *
 * Measured 2026-10-29:
 *
 *   anonymous  /api/entity/tle, /api/entity/omm/json, /api/entity/satcat,
 *              /api/entity/satcat/supplemental, /api/spaceweather/*, /api/eop/*
 *   401        /api/Scene, /api/Model, /api/UserEphemeris
 *   405        /api/Entity  (it is a POST endpoint)
 *
 * Everything the catalogue needs is anonymous. The token matters for the
 * per-object scene/model endpoints, which carry the covariance series a Pk
 * analysis plots.
 *
 * ## Token storage
 *
 * The refresh token is written to `data/.spacebook-token.json`, which is
 * gitignored. It is never logged, never returned by an API route, and the helper
 * that reads it redacts it in every error message.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

export const SPACEBOOK_AUTH0_DOMAIN = "comspoc-spacebook.us.auth0.com";
export const SPACEBOOK_CLIENT_ID = "o8A7Txz1uNaDrS7ICrOfFuOb7SXtE0fy";
export const SPACEBOOK_AUDIENCE = "spacebook-api-prod";
/** The SPA passes `window.location.origin`, so the registered callback is the apex. */
export const SPACEBOOK_REDIRECT_URI = "https://www.spacebook.com";

const TOKEN_URL = `https://${SPACEBOOK_AUTH0_DOMAIN}/oauth/token`;
const AUTHORIZE_URL = `https://${SPACEBOOK_AUTH0_DOMAIN}/authorize`;

export interface StoredToken {
  accessToken: string;
  refreshToken: string | null;
  /** Unix ms. */
  expiresAt: number;
  scope: string | null;
  obtainedAt: string;
}

export interface PkceRequest {
  /** Paste this into a browser; after login the address bar carries `?code=`. */
  url: string;
  /** Must be handed back to `exchangeCode`. Not secret once the code is spent. */
  verifier: string;
  state: string;
}

export interface SpacebookAuthOptions {
  /** Where the refresh token is cached. Default `data/.spacebook-token.json`. */
  tokenPath?: string;
  timeoutMs?: number;
}

/** Read the cached token, or null when there is none or it is unreadable. */
export async function readStoredToken(tokenPath = defaultTokenPath()): Promise<StoredToken | null> {
  if (!existsSync(tokenPath)) return null;
  try {
    const parsed = JSON.parse(await readFile(tokenPath, "utf8")) as StoredToken;
    if (!parsed.accessToken) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Write the token atomically: a half-written token file is worse than none. */
export async function writeStoredToken(
  token: StoredToken,
  tokenPath = defaultTokenPath(),
): Promise<void> {
  await mkdir(dirname(tokenPath), { recursive: true });
  const tmp = `${tokenPath}.part`;
  await writeFile(tmp, JSON.stringify(token, null, 2), { mode: 0o600 });
  await rename(tmp, tokenPath);
}

export function defaultTokenPath(cwd = process.cwd()): string {
  return join(cwd, "data", ".spacebook-token.json");
}

export class SpacebookAuth {
  private readonly tokenPath: string;
  private readonly timeoutMs: number;
  private cached: StoredToken | null = null;

  constructor(options: SpacebookAuthOptions = {}) {
    this.tokenPath = options.tokenPath ?? defaultTokenPath();
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /**
   * Build the authorize URL and the PKCE verifier.
   *
   * Public clients cannot keep a secret, so the code exchange is bound to a
   * hashed random verifier instead. S256, not plain: Auth0 rejects `plain` for
   * this client.
   */
  static beginLogin(): PkceRequest {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(8).toString("hex");

    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", SPACEBOOK_CLIENT_ID);
    url.searchParams.set("redirect_uri", SPACEBOOK_REDIRECT_URI);
    url.searchParams.set("scope", "openid profile email offline_access");
    url.searchParams.set("audience", SPACEBOOK_AUDIENCE);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);

    return { url: url.toString(), verifier, state };
  }

  /**
   * Turn an authorization code into a token and cache it.
   *
   * `redirectUri` must match the one used in `beginLogin`. When the browser
   * redirects to `https://www.spacebook.com/?code=…`, the code is read off that
   * address and posted back here.
   */
  async exchangeCode(
    code: string,
    verifier: string,
    redirectUri = SPACEBOOK_REDIRECT_URI,
  ): Promise<StoredToken> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: SPACEBOOK_CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    });

    const token = await this.post(body, "code exchange");
    await writeStoredToken(token, this.tokenPath);
    this.cached = token;
    return token;
  }

  /** Exchange the cached refresh token for a new access token. */
  async refresh(): Promise<StoredToken> {
    const current = this.cached ?? (await readStoredToken(this.tokenPath));
    if (!current?.refreshToken) {
      throw new Error(
        "no Spacebook refresh token; run `npm run spacebook:login` and complete the browser step",
      );
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: SPACEBOOK_CLIENT_ID,
      refresh_token: current.refreshToken,
    });
    const token = await this.post(body, "refresh");
    await writeStoredToken(token, this.tokenPath);
    this.cached = token;
    return token;
  }

  /**
   * A usable access token: cached, refreshed, or newly refreshed on expiry.
   *
   * Returns null when there is no token at all, which is the normal state before
   * the one-time browser login and must not be treated as an error by callers
   * that only need the anonymous catalogue.
   */
  async accessToken(): Promise<string | null> {
    const current = this.cached ?? (await readStoredToken(this.tokenPath));
    if (!current) return null;
    // 60 s of slack: a token that expires mid-request is indistinguishable from
    // a revoked one, which makes the failure hard to diagnose.
    if (current.expiresAt - 60_000 > Date.now()) {
      this.cached = current;
      return current.accessToken;
    }
    const refreshed = await this.refresh();
    return refreshed.accessToken;
  }

  /** Whether a cached refresh token exists, without performing a request. */
  async hasCredentials(): Promise<boolean> {
    const current = this.cached ?? (await readStoredToken(this.tokenPath));
    return Boolean(current?.refreshToken);
  }

  private async post(body: URLSearchParams, what: string): Promise<StoredToken> {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const text = await res.text();
    if (!res.ok) {
      // Auth0's error bodies name the grant, never the secret, so they are safe
      // to surface — and they are the only way to tell "revoked" from
      // "expired" from "wrong client".
      throw new Error(`Spacebook ${what} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    }

    const json = JSON.parse(text) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    if (!json.access_token) {
      throw new Error(`Spacebook ${what} returned no access_token`);
    }

    return {
      accessToken: json.access_token,
      // Auth0 omits the refresh token on refresh unless rotation is enabled; keep
      // the old one so a second refresh does not lose the ability to refresh.
      refreshToken: json.refresh_token ?? this.cached?.refreshToken ?? null,
      expiresAt: Date.now() + (json.expires_in ?? 86_400) * 1000,
      scope: json.scope ?? null,
      obtainedAt: new Date().toISOString(),
    };
  }
}

/**
 * Pull `code` out of whatever the browser ended up showing.
 *
 * People paste either the whole callback URL or just the code, and the URL may
 * be the redirect target with a trailing slash. Accepting all three is the
 * difference between a working login and "invalid code" with no clue why.
 */
export function extractAuthCode(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;

  // Anything that looks like a URL must produce a `code` parameter or nothing.
  // Returning the whole URL as though it were a code is how `#/xp-tle` — the SPA
  // deep link a user lands on after the redirect is swallowed — got posted to
  // Auth0 as a code and came back as an opaque "invalid_grant".
  const looksLikeUrl = /^https?:\/\//i.test(trimmed) || trimmed.includes("?");
  if (!looksLikeUrl) {
    // A bare code: base64url or hex, no separators. Reject anything with URL
    // punctuation so a pasted fragment cannot masquerade as a code.
    return /^[A-Za-z0-9._~+/=-]+$/.test(trimmed) ? trimmed : null;
  }

  try {
    return new URL(trimmed).searchParams.get("code");
  } catch {
    const match = /[?&]code=([^&\s#]+)/.exec(trimmed);
    return match ? decodeURIComponent(match[1]) : null;
  }
}
