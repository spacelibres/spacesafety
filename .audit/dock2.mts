import puppeteer from "puppeteer-core";
const BASE = "http://127.0.0.1:3000";
const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const p = await b.newPage();
await p.setViewport({ width: 1440, height: 900 });

await p.goto(BASE + "/catalogue", { waitUntil: "networkidle2", timeout: 180000 });
const info = await p.evaluate(() => {
  const sels = [...document.querySelectorAll(".pref-dock select")] as HTMLSelectElement[];
  return {
    cookie: document.cookie,
    theme: document.documentElement.dataset.theme,
    selects: sels.map((s) => ({ value: s.value, options: [...s.options].map((o) => o.value), aria: s.getAttribute("aria-label") })),
  };
});
console.log("初始:", JSON.stringify(info, null, 1));

// Drive the theme select by index, not by a CSS pseudo-class.
const sel = (await p.$$(".pref-dock select"))[1];
await p.evaluate(() => { const s = document.querySelectorAll(".pref-dock select")[1] as HTMLSelectElement; s.value = "light"; s.dispatchEvent(new Event("change", { bubbles: true })); });
await new Promise((r) => setTimeout(r, 4000));
const after = await p.evaluate(() => ({ cookie: document.cookie, theme: document.documentElement.dataset.theme, value: (document.querySelectorAll(".pref-dock select")[1] as HTMLSelectElement).value }));
console.log("选 light 后:", JSON.stringify(after));
await b.close();
