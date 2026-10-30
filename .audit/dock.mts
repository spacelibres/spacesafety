import puppeteer from "puppeteer-core";
const BASE = "http://127.0.0.1:3000";
const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const p = await b.newPage();
await p.setViewport({ width: 1440, height: 900 });
const errs: string[] = [];
p.on("pageerror", (e) => errs.push("PAGEERROR: " + e.message.slice(0, 160)));
p.on("console", (m) => { if (m.type() === "error") errs.push("CONSOLE: " + m.text().slice(0, 160)); });

await p.goto(BASE + "/catalogue", { waitUntil: "networkidle2", timeout: 180000 });
const before = await p.evaluate(() => ({
  dock: !!document.querySelector(".pref-dock"),
  selects: document.querySelectorAll(".pref-dock select").length,
  labels: [...document.querySelectorAll(".pref-label")].map((e) => e.textContent),
  sidebarLanguage: !!document.querySelector(".sidebar-language"),
  theme: document.documentElement.dataset.theme,
  lang: document.documentElement.lang,
}));
console.log("挂载前:", JSON.stringify(before));

// Switch the theme through the real control and wait for the reload.
await p.select(".pref-dock select:last-of-type", "light");
await p.waitForNavigation({ waitUntil: "networkidle2", timeout: 120000 }).catch(() => {});
const after = await p.evaluate(() => ({
  theme: document.documentElement.dataset.theme,
  theme2: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
  bodyBg: getComputedStyle(document.body).backgroundColor,
}));
console.log("切到 light 后:", JSON.stringify(after));

// Switch the language through the dock as well.
await p.select(".pref-dock select:first-of-type", "en");
await p.waitForNavigation({ waitUntil: "networkidle2", timeout: 120000 }).catch(() => {});
const afterLang = await p.evaluate(() => ({
  lang: document.documentElement.lang,
  title: document.querySelector(".page-title")?.textContent,
}));
console.log("切到 en 后:", JSON.stringify(afterLang));
console.log("控制台错误:", errs.length ? errs.slice(0, 5) : "无");
await b.close();
