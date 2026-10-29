/**
 * One-time Spacebook login, then refresh thereafter.
 *
 * Spacebook's Auth0 tenant only permits `authorization_code`, so a token cannot
 * be minted from the stored password. The flow is:
 *
 *   1. `npm run spacebook:login` prints an authorize URL and a verifier.
 *   2. You open the URL, sign in, and the browser lands on
 *      `https://www.spacebook.com/?code=…` (the SPA may swallow it and show the
 *      map instead — the address bar is what matters, so copy it before it is
 *      replaced).
 *   3. `npm run spacebook:login -- --code '<url or code>' --verifier <v>` trades
 *      the code for tokens and caches the refresh token in
 *      `data/.spacebook-token.json`.
 *
 * After that `--refresh` (or any fetch that needs a token) renews silently.
 *
 *   npm run spacebook:login              # print the authorize URL
 *   npm run spacebook:login -- --code …  # finish the exchange
 *   npm run spacebook:login -- --refresh # renew from the cached token
 *   npm run spacebook:login -- --status  # show what is cached, without secrets
 */

async function main(): Promise<void> {
  const { loadEnvLocal } = await import("./env");
  loadEnvLocal();

  const { SpacebookAuth, extractAuthCode, readStoredToken, defaultTokenPath } = await import(
    "../src/lib/sources/spacebook-auth"
  );

  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };

  const auth = new SpacebookAuth();

  if (argv.includes("--status")) {
    const token = await readStoredToken(defaultTokenPath());
    if (!token) {
      console.log("\n  no cached token\n  run `npm run spacebook:login` to create one\n");
      return;
    }
    const remainingMin = Math.round((token.expiresAt - Date.now()) / 60_000);
    console.log("\n  cached token");
    console.log(`    obtained     ${token.obtainedAt}`);
    console.log(`    expires      in ${remainingMin} min`);
    console.log(`    refreshable  ${token.refreshToken ? "yes" : "no"}`);
    console.log(`    scope        ${token.scope ?? "—"}`);
    console.log(`    path         ${defaultTokenPath()}\n`);
    return;
  }

  if (argv.includes("--refresh")) {
    try {
      const token = await auth.refresh();
      console.log(
        `\n  refreshed; valid for ${Math.round((token.expiresAt - Date.now()) / 60_000)} min\n`,
      );
    } catch (err) {
      console.error(`\n  ${(err as Error).message}\n`);
      process.exit(1);
    }
    return;
  }

  const codeInput = flag("--code");
  if (!codeInput) {
    const request = SpacebookAuth.beginLogin();
    console.log("\n  Spacebook login — step 1 of 2\n");
    console.log("  1. Open this URL and sign in:\n");
    console.log(`     ${request.url}\n`);
    console.log("  2. The browser will land on https://www.spacebook.com/?code=<...>.");
    console.log("     Copy that whole address (or just the code value), then run:\n");
    console.log(
      `     npm run spacebook:login -- --code '<address or code>' --verifier ${request.verifier}\n`,
    );
    console.log("  The verifier expires with this process; paste both in one go.\n");
    return;
  }

  const verifier = flag("--verifier");
  if (!verifier) {
    console.error("\n  --verifier is required alongside --code (it is printed in step 1)\n");
    process.exit(1);
  }

  const code = extractAuthCode(codeInput);
  if (!code) {
    console.error("\n  could not find a `code` parameter in the value given\n");
    process.exit(1);
  }

  try {
    const token = await auth.exchangeCode(code, verifier);
    console.log("\n  login complete");
    console.log(`    valid for    ${Math.round((token.expiresAt - Date.now()) / 60_000)} min`);
    console.log(`    refreshable  ${token.refreshToken ? "yes" : "no"}`);
    console.log(`    cache        ${defaultTokenPath()}\n`);
  } catch (err) {
    console.error(`\n  ${(err as Error).message}\n`);
    process.exit(1);
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});

export {};
