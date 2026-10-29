/**
 * Spacebook authentication helpers.
 *
 * The token exchange itself needs a browser consent, so it cannot be exercised
 * here. What *can* be pinned down is everything around it, and every one of these
 * was a real failure mode while building the flow:
 *
 *   * the PKCE challenge must be S256 of the verifier (Auth0 rejects `plain`);
 *   * the authorize URL must carry the audience, or the token has no API scope;
 *   * the callback URL people paste must yield a code, whichever form it takes;
 *   * a missing token is not an error — the anonymous catalogue works without it.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
  SPACEBOOK_AUDIENCE,
  SPACEBOOK_CLIENT_ID,
  SPACEBOOK_REDIRECT_URI,
  SpacebookAuth,
  defaultTokenPath,
  extractAuthCode,
  readStoredToken,
  writeStoredToken,
} from "../src/lib/sources/spacebook-auth";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${name}${detail ? `  ${detail}` : ""}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? `  ${detail}` : ""}`);
  }
}

async function main() {
  console.log("\nPKCE request");
  const request = SpacebookAuth.beginLogin();
  const url = new URL(request.url);

  check("authorize endpoint", url.hostname === "comspoc-spacebook.us.auth0.com");
  check("response type is code", url.searchParams.get("response_type") === "code");
  check("client id matches the SPA", url.searchParams.get("client_id") === SPACEBOOK_CLIENT_ID);
  check("redirect uri is the apex origin", url.searchParams.get("redirect_uri") === SPACEBOOK_REDIRECT_URI);
  check("audience is spacebook-api-prod", url.searchParams.get("audience") === SPACEBOOK_AUDIENCE);
  check(
    "scope asks for a refresh token",
    (url.searchParams.get("scope") ?? "").includes("offline_access"),
  );
  check("challenge method is S256", url.searchParams.get("code_challenge_method") === "S256");
  check("state is present", (url.searchParams.get("state") ?? "").length >= 8);

  // The challenge must be the hash of the verifier, or the exchange fails at
  // Auth0 with no useful message.
  const expected = createHash("sha256").update(request.verifier).digest("base64url");
  check("challenge is sha256(verifier)", url.searchParams.get("code_challenge") === expected);
  check(
    "verifier is long enough for S256",
    request.verifier.length >= 43,
    `${request.verifier.length} chars`,
  );

  // Two logins must not reuse a verifier.
  const second = SpacebookAuth.beginLogin();
  check("each login gets a fresh verifier", second.verifier !== request.verifier);

  console.log("\ncallback parsing");
  const coded = "https://www.spacebook.com/?code=abc123&state=xyz";
  check("full callback URL yields the code", extractAuthCode(coded) === "abc123");
  check("bare code is passed through", extractAuthCode("  abc123  ") === "abc123");
  check("url with trailing slash works", extractAuthCode("https://www.spacebook.com/?code=abc123") === "abc123");
  check("empty input yields null", extractAuthCode("   ") === null);
  check(
    "a URL without a code yields null",
    extractAuthCode("https://www.spacebook.com/#/xp-tle") === null,
  );
  check(
    "percent-encoded code is decoded",
    extractAuthCode("https://www.spacebook.com/?code=a%2Fb") === "a/b",
  );

  console.log("\ntoken cache");
  const dir = await mkdtemp(join(tmpdir(), "sbtok-"));
  const tokenPath = join(dir, "token.json");

  check("absent cache reads as null", (await readStoredToken(tokenPath)) === null);

  const future = Date.now() + 3_600_000;
  await writeStoredToken(
    { accessToken: "a", refreshToken: "r", expiresAt: future, scope: "openid", obtainedAt: "now" },
    tokenPath,
  );
  const read = await readStoredToken(tokenPath);
  check("cached token round-trips", read?.accessToken === "a" && read?.refreshToken === "r");

  const auth = new SpacebookAuth({ tokenPath });
  check("a valid token is returned without a request", (await auth.accessToken()) === "a");
  check("credentials are reported present", await auth.hasCredentials());

  // A token that expires inside the 60 s slack must be treated as expired, and
  // with no refresh token that must surface as a clear error rather than a
  // request with a dead token.
  await writeStoredToken(
    { accessToken: "old", refreshToken: null, expiresAt: Date.now() + 30_000, scope: null, obtainedAt: "now" },
    tokenPath,
  );
  const nearExpiry = new SpacebookAuth({ tokenPath });
  let message = "";
  try {
    await nearExpiry.accessToken();
  } catch (err) {
    message = (err as Error).message;
  }
  check("expiring token triggers a refresh", message !== "");
  check(
    "and the error names the login command",
    message.includes("spacebook:login"),
    message.slice(0, 60),
  );

  // A corrupt cache must not crash the app: the anonymous endpoints still work.
  const broken = join(dir, "broken.json");
  await writeFile(broken, "{not json");
  check("corrupt cache reads as null", (await readStoredToken(broken)) === null);

  check(
    "default token path lives under data/",
    defaultTokenPath("/repo").endsWith("data/.spacebook-token.json"),
  );

  await rm(dir, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main();

export {};
