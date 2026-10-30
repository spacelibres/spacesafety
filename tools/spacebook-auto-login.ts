/**
 * Automated Spacebook login by driving the real Auth0 page.
 *
 * ## Why a browser is the only remaining option
 *
 * Measured against the tenant (`comspoc-spacebook.us.auth0.com`), the client
 * `o8A7Txz1uNaDrS7ICrOfFuOb7SXtE0fy` allows exactly one grant:
 *
 *   authorization_code          allowed
 *   password                    403 unauthorized_client
 *   password-realm (ROPG)       403 unauthorized_client
 *   device_code                 405/403 unauthorized_client
 *   client_credentials          401 (public client, no secret)
 *
 * So the username and password cannot be posted to a token endpoint. They can only
 * be typed into the login form. That is what this does: launch the browser, fill the
 * form, and capture the `code` from the redirect.
 *
 * ## What this is not
 *
 * Not a bypass. It is the same consent a person gives by hand, performed by a
 * script. The account owner has supplied the credentials and asked for this, and the
 * tenant's own rate limits and bot checks remain in force — if Auth0 presents a
 * CAPTCHA, this fails and a human must take over.
 *
 * ## The token still cannot be refreshed
 *
 * The tenant returns `scope=openid profile email` even when `offline_access` is
 * requested, so no refresh token is issued and every run of this script is a fresh
 * login. It works, but it is a login, not a renewal.
 *
 * Run: npx tsx tools/spacebook-auto-login.ts
 *      npx tsx tools/spacebook-auto-login.ts --show   # visible window, for debugging
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { loadEnvLocal } from "../scripts/env";

loadEnvLocal();

const DOMAIN = "comspoc-spacebook.us.auth0.com";
const CLIENT_ID = "o8A7Txz1uNaDrS7ICrOfFuOb7SXtE0fy";
const AUDIENCE = "spacebook-api-prod";
const REDIRECT = "https://www.spacebook.com";
const TOKEN_PATH = "data/.spacebook-token.json";

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function main(): Promise<void> {
  const show = process.argv.includes("--show");
  const user = process.env.SPACE_SAFETY_SPACEBOOK_USER;
  const pass = process.env.SPACE_SAFETY_SPACEBOOK_PASS;

  if (!user || !pass) {
    console.error("\n  缺少 SPACE_SAFETY_SPACEBOOK_USER / _PASS\n");
    process.exit(1);
  }

  let puppeteer: typeof import("puppeteer-core");
  try {
    puppeteer = await import("puppeteer-core");
  } catch {
    console.error("\n  需要 puppeteer-core：npm install --no-save puppeteer-core\n");
    process.exit(1);
  }

  // PKCE, same as the manual flow.
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());

  const authUrl =
    `https://${DOMAIN}/authorize?response_type=code&client_id=${CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
    `&scope=${encodeURIComponent("openid profile email offline_access")}` +
    `&audience=${AUDIENCE}&code_challenge=${challenge}&code_challenge_method=S256`;

  console.log("\n  启动浏览器登录 Spacebook…\n");

  const browser = await puppeteer.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: !show,
    args: [
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--window-size=1280,900",
    ],
  });

  let code: string | null = null;

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
    );

    // The redirect carries the code. Watching navigation is more reliable than
    // waiting for a selector, because the SPA may immediately replace the URL.
    page.on("response", (res) => {
      const u = res.url();
      if (u.startsWith(REDIRECT) && u.includes("code=")) {
        try {
          const c = new URL(u).searchParams.get("code");
          if (c) code = c;
        } catch {
          // A malformed redirect is not the one we want.
        }
      }
    });

    await page.goto(authUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

    // Auth0 universal login here is two screens: identifier, then password. The
    // first script waited for a password field on the identifier screen, where none
    // exists, and timed out 30 s later reporting "captcha or MFA" — a wrong guess.
    // Each step is now driven by the URL, which changes between screens.
    await page.waitForSelector('input[type="email"], input[name="username"], input[name="email"]', {
      timeout: 30_000,
    });

    const typeInto = async (selector: string, value: string): Promise<boolean> => {
      const el = await page.$(selector);
      if (!el) return false;
      await el.click({ count: 3 });
      await el.type(value, { delay: 20 });
      return true;
    };

    const clickContinue = async (): Promise<void> => {
      await page.evaluate(() => {
        const btn =
          document.querySelector<HTMLButtonElement>('button[type="submit"]') ??
          document.querySelector<HTMLButtonElement>("button[name='action']");
        btn?.click();
      });
    };

    // Screen 1: identifier.
    const emailOk =
      (await typeInto('input[name="username"]', user)) ||
      (await typeInto('input[type="email"]', user)) ||
      (await typeInto('input[name="email"]', user));
    if (!emailOk) throw new Error("找不到邮箱输入框");
    await clickContinue();

    // Screen 2: password.
    await page.waitForSelector('input[type="password"]', { timeout: 30_000 });
    if (!(await typeInto('input[type="password"]', pass))) throw new Error("找不到密码输入框");
    await clickContinue();

    // Wait for the redirect, or for an error message that explains why not.
    const deadline = Date.now() + 60_000;
    while (code === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      const current = page.url();
      if (current.startsWith(REDIRECT) && current.includes("code=")) {
        code = new URL(current).searchParams.get("code");
      }
      if (code === null) {
        const err = await page
          .$eval(".auth0-global-message, .error, [class*='error']", (el) => el.textContent?.trim() ?? "")
          .catch(() => "");
        if (err && /wrong|invalid|incorrect/i.test(err)) {
          throw new Error(`登录被拒：${err.slice(0, 160)}`);
        }
      }
    }

    if (!code) throw new Error("等待授权码超时（可能遇到验证码或二次验证，需人工介入）");

    // Exchange the code for tokens.
    const tokenRes = await fetch(`https://${DOMAIN}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
      }),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      throw new Error(`换取 token 失败 HTTP ${tokenRes.status}: ${body.slice(0, 200)}`);
    }

    const json = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope?: string;
    };

    const out = {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? null,
      expiresAt: Date.now() + json.expires_in * 1000,
      obtainedAt: new Date().toISOString(),
      scope: json.scope ?? null,
    };

    if (!existsSync(dirname(TOKEN_PATH))) mkdirSync(dirname(TOKEN_PATH), { recursive: true });
    writeFileSync(TOKEN_PATH, JSON.stringify(out, null, 2), { mode: 0o600 });

    console.log(`  登录成功`);
    console.log(`    有效期    ${Math.round(json.expires_in / 60)} 分钟（${Math.round(json.expires_in / 3600)} 小时）`);
    console.log(`    scope     ${out.scope ?? "—"}`);
    console.log(`    可续期    ${out.refreshToken ? "是" : "否"}`);
    console.log(`    缓存      ${TOKEN_PATH}\n`);
  } finally {
    await browser.close();
  }
}

void main().catch((err) => {
  console.error(`\n  ${(err as Error).message}\n`);
  process.exit(1);
});
