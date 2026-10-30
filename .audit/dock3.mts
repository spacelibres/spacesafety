import puppeteer from "puppeteer-core";
const BASE = "http://127.0.0.1:3000";
const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const p = await b.newPage();
await p.setViewport({ width: 1440, height: 900 });
const errs: string[] = [];
p.on("pageerror", (e) => errs.push("PAGEERROR: " + e.message.slice(0, 160)));
p.on("console", (m) => { if (m.type() === "error") errs.push("CONSOLE: " + m.text().slice(0, 160)); });

const set = async (index: number, value: string) => {
  await p.evaluate((i, v) => {
    const s = document.querySelectorAll(".pref-dock select")[i] as HTMLSelectElement;
    s.value = v;
    s.dispatchEvent(new Event("change", { bubbles: true }));
  }, index, value);
  await p.waitForNavigation({ waitUntil: "networkidle2", timeout: 120000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
};

await p.goto(BASE + "/catalogue", { waitUntil: "networkidle2", timeout: 180000 });
await set(0, "en");
console.log("语言→en:", JSON.stringify(await p.evaluate(() => ({ lang: document.documentElement.lang, title: document.querySelector(".page-title")?.textContent, cookie: document.cookie }))));

await set(1, "dark");
console.log("外观→dark:", JSON.stringify(await p.evaluate(() => ({ theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(), cookie: document.cookie }))));

console.log("布局:", JSON.stringify(await p.evaluate(() => ({
  sidebarW: getComputedStyle(document.querySelector(".sidebar")!).width,
  icons: document.querySelectorAll(".nav-icon").length,
  dockSelects: document.querySelectorAll(".pref-dock select").length,
  cjk: (document.body.innerText.replace(/(简体中文|English|Español|Français|Deutsch|日本語)/g, "").match(/[\u4e00-\u9fff]/g) ?? []).length,
}))));
console.log("控制台错误:", errs.length ? errs.slice(0, 5) : "无");
await b.close();
