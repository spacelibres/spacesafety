/**
 * Diagnose where the automated Spacebook login stops.
 *
 * A timeout says nothing about why. This dumps the page title, URL and visible text
 * at each step so the stopping point is identifiable — a CAPTCHA, a consent screen,
 * a bot check, or a selector that no longer matches the form.
 *
 * Run: npx tsx tools/spacebook-login-diag.ts
 */

import { createHash, randomBytes } from "node:crypto";

import { loadEnvLocal } from "../scripts/env";

loadEnvLocal();

const DOMAIN = "comspoc-spacebook.us.auth0.com";
const CLIENT_ID = "o8A7Txz1uNaDrS7ICrOfFuOb7SXtE0fy";
const REDIRECT = "https://www.spacebook.com";

function b64url(b: Buffer): string {
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function dump(page: import("puppeteer-core").Page, label: string): Promise<void> {
  const title = await page.title().catch(() => "?");
  const url = page.url();
  const text = await page
    .evaluate(() => document.body?.innerText?.replace(/\n{2,}/g, "\n").slice(0, 500) ?? "")
    .catch(() => "");
  const inputs = await page
    .evaluate(() =>
      Array.from(document.querySelectorAll("input")).map(
        (i) => `${i.type || "text"}:${i.name || i.id || "?"}`,
      ),
    )
    .catch(() => []);
  const buttons = await page
    .evaluate(() =>
      Array.from(document.querySelectorAll("button")).map((b) => (b.innerText || "").trim().slice(0, 30)),
    )
    .catch(() => []);

  console.log(`\n  ── ${label} ──`);
  console.log(`  URL    ${url}`);
  console.log(`  title  ${title}`);
  console.log(`  inputs ${inputs.join(", ")}`);
  console.log(`  buttons ${buttons.filter(Boolean).join(" | ")}`);
  console.log(`  text   ${text.replace(/\n/g, " / ").slice(0, 300)}`);
}

async function main(): Promise<void> {
  const puppeteer = await import("puppeteer-core");
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());

  const authUrl =
    `https://${DOMAIN}/authorize?response_type=code&client_id=${CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
    `&scope=${encodeURIComponent("openid profile email")}` +
    `&audience=spacebook-api-prod&code_challenge=${challenge}&code_challenge_method=S256`;

  const browser = await puppeteer.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
    );
    page.on("console", (m) => {
      if (m.type() === "error") console.log(`    [console error] ${m.text().slice(0, 120)}`);
    });

    await page.goto(authUrl, { waitUntil: "networkidle2", timeout: 60_000 });
    await dump(page, "1. 打开授权页后");

    // Try to fill the identifier field whatever it is called.
    const user = process.env.SPACE_SAFETY_SPACEBOOK_USER ?? "";
    const pass = process.env.SPACE_SAFETY_SPACEBOOK_PASS ?? "";

    const filled = await page.evaluate((u: string, p: string) => {
      const email = document.querySelector<HTMLInputElement>(
        'input[type="email"], input[name="username"], input[name="email"]',
      );
      if (!email) return "no-email-field";
      email.value = u;
      email.dispatchEvent(new Event("input", { bubbles: true }));
      email.dispatchEvent(new Event("change", { bubbles: true }));

      const pw = document.querySelector<HTMLInputElement>('input[type="password"]');
      if (pw) {
        pw.value = p;
        pw.dispatchEvent(new Event("input", { bubbles: true }));
        pw.dispatchEvent(new Event("change", { bubbles: true }));
        return "filled-both";
      }
      return "filled-email-only";
    }, user, pass);

    console.log(`\n  填充结果：${filled}`);
    await dump(page, "2. 填充表单后");

    // Submit.
    await page.evaluate(() => {
      const btn =
        document.querySelector<HTMLButtonElement>('button[type="submit"]') ??
        document.querySelector<HTMLButtonElement>("button[name='action']");
      btn?.click();
    });
    await new Promise((r) => setTimeout(r, 6000));
    await dump(page, "3. 提交后");
  } finally {
    await browser.close();
  }
  console.log("");
}

void main();
