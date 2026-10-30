import puppeteer from "puppeteer-core";
const BASE = "http://127.0.0.1:3000";
const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const p = await b.newPage();
await p.setViewport({ width: 1440, height: 900 });

for (const loc of ["en", "zh-CN"]) {
  await p.setCookie({ name: "locale", value: loc, domain: "127.0.0.1", path: "/" });
  for (const path of ["/catalogue", "/browse", "/statistics", "/objects/5"]) {
    await p.goto(BASE + path, { waitUntil: "networkidle2", timeout: 180000 });
    const r = await p.evaluate(() => {
      const text = document.body.innerText;
      // Language names in the switcher are always written in their own language.
      const stripped = text.replace(/(简体中文|English|Español|Français|Deutsch|日本語)/g, "");
      const cjk = stripped.match(/[\u4e00-\u9fff]/g) ?? [];
      return { lang: document.documentElement.lang, cjk: cjk.length, sample: stripped.match(/[\u4e00-\u9fff][^\n]{0,24}/g)?.slice(0, 4) ?? [] };
    });
    console.log(loc.padEnd(6), path.padEnd(14), JSON.stringify(r));
  }
}
await b.close();
