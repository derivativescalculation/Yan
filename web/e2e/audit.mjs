// Live-site audit: every route, zh + en, desktop + phone.
// Flags console/page errors, failed requests, horizontal overflow, stuck loading states,
// placeholder values, superseded addresses and broken links. Screenshots go to e2e/audit/.
//   SITE=https://yansuan.io node e2e/audit.mjs
import { chromium } from "playwright";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const SITE = process.env.SITE ?? "https://yansuan.io";
const OUT = fileURLToPath(new URL("./audit/", import.meta.url));
fs.mkdirSync(OUT, { recursive: true });

const ROUTES = ["/", "/mine", "/agent", "/agent/401787", "/treasury", "/docs", "/does-not-exist"];
const VIEWPORTS = { desktop: { width: 1440, height: 1000 }, phone: { width: 390, height: 844 } };
const LANGS = ["zh", "en"];
const SUPERSEDED = [
  "0xa19cB6ef09E3a5fDc36230afd25e1044078100Fd", "0x073648Dd60402E39C332B49d76728EAE2820d2d8",
  "0x460461dBa2643b62514ad199F0746ec080752e56", "0xbED42bc64FF8B69075626402b6fa6B3b3202C52c",
  "0x7AE827a0a4254D1dA84129a624EA1D61F5D79353", "0xBA4930D6152A30b5e371720C6000CC7f218486d3",
];
const LOADING = /读取链上数据|Reading chain/;

const browser = await chromium.launch({ channel: "msedge", headless: true });
const findings = [];
const links = new Set();
const note = (where, what) => findings.push(`${where}: ${what}`);

for (const lang of LANGS) {
  for (const [vp, size] of Object.entries(VIEWPORTS)) {
    const ctx = await browser.newContext({ viewport: size, deviceScaleFactor: 1 });
    await ctx.addInitScript((l) => { try { localStorage.setItem("lang", l); } catch {} }, lang);
    const page = await ctx.newPage();
    page.setDefaultTimeout(45_000);
    for (const route of ROUTES) {
      const where = `${lang}/${vp}${route}`;
      const errs = [];
      const onErr = (e) => errs.push("pageerror " + e.message);
      const onCon = (m) => { if (m.type() === "error") errs.push("console " + m.text().slice(0, 160)); };
      const onResp = (r) => { if (r.status() >= 400 && !/favicon/.test(r.url())) errs.push(`HTTP ${r.status()} ${r.url().slice(0, 120)}`); };
      page.on("pageerror", onErr); page.on("console", onCon); page.on("response", onResp);
      await page.goto(SITE + route, { waitUntil: "load" });
      // let chain reads and the gateway respond
      for (let i = 0; i < 20; i++) {
        const t = await page.evaluate(() => document.body.innerText);
        if (!LOADING.test(t) && !/…/.test(t.split("\n").slice(0, 40).join(" "))) break;
        await page.waitForTimeout(1500);
      }
      await page.waitForTimeout(2500);
      const text = await page.evaluate(() => document.body.innerText);
      const html = await page.content();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 1) note(where, `horizontal overflow ${overflow}px`);
      if (LOADING.test(text)) note(where, "still loading after wait");
      for (const a of SUPERSEDED) if (html.toLowerCase().includes(a.toLowerCase())) note(where, `superseded address on page ${a}`);
      const dashes = (text.match(/(^|\s)—(\s|$)/g) || []).length;
      if (dashes > 0 && route !== "/agent") note(where, `${dashes} placeholder "—" values`);
      for (const e of errs) note(where, e);
      (await page.$$eval("a[href]", (as) => as.map((a) => a.href))).forEach((h) => links.add(h));
      await page.screenshot({ path: OUT + `${lang}-${vp}${route.replace(/\//g, "_") || "_"}.png`, fullPage: true });
      page.off("pageerror", onErr); page.off("console", onCon); page.off("response", onResp);
    }
    await ctx.close();
  }
}
await browser.close();

// external + internal links
for (const href of links) {
  if (href.startsWith("mailto:")) continue;
  try {
    const r = await fetch(href, { method: "GET", redirect: "follow", headers: { "user-agent": "Mozilla/5.0 audit" } });
    if (r.status >= 400 && !/x\.com|twitter\.com/.test(href)) note("link", `${r.status} ${href}`);
  } catch (e) {
    note("link", `unreachable ${href}`);
  }
}

console.log(`routes ${ROUTES.length} x langs ${LANGS.length} x viewports 2, links checked ${links.size}`);
console.log([...links].filter((l) => !l.startsWith(SITE)).sort().join("\n"));
console.log(findings.length ? "FINDINGS:\n" + findings.join("\n") : "NO FINDINGS");
