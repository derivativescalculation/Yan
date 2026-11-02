// Functional check of the mine page's prompt builder on a live site (read-only: nothing is sent).
//   SITE=https://yansuan.io node e2e/planner.mjs
import { chromium } from "playwright";

const SITE = process.env.SITE ?? "https://yansuan.io";
const step = (s) => console.log("•", s);
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
page.setDefaultTimeout(45_000);
const prompt = async () => (await page.locator(".code pre").first().innerText()).trim();
const raw = async () => (await page.locator(".code pre").nth(1).innerText()).trim();

try {
  await page.goto(`${SITE}/mine`, { waitUntil: "load" });
  await page.locator(".kvl").getByText(/YAN\/USD/).waitFor();
  await page.waitForTimeout(3000);
  const minter = (await raw()).match(/to:\s+(0x[0-9a-fA-F]{40})/)?.[1];
  if (!minter) throw new Error("raw transaction has no minter address");

  await page.locator(".chips button", { hasText: /^0\.02$/ }).click();
  await page.waitForTimeout(2000);
  let p = await prompt();
  if (!p.includes(`--to ${minter}`) || !p.includes("--value 20000000000000000") || !p.includes("--inputData 0x99f4b251")) throw new Error("prompt not filled: " + p);
  if (!p.includes("baw wallet agent-id") || !p.includes("devMode")) throw new Error("prompt missing identity / developer-mode checks");
  const kv = await page.locator(".kvl").innerText();
  if (!/\d+\.\d\d USD/.test(kv) || !/\d[\d,]* YAN/.test(kv)) throw new Error("calculator values missing: " + kv);
  step(`preset 0.02 -> prompt filled with ${minter}, 20000000000000000 wei and mine(); ${kv.split("\n").slice(0, 4).join(" | ")}`);

  await page.locator(".field input").first().fill("0.0123");
  await page.waitForTimeout(1500);
  p = await prompt();
  if (!p.includes("--value 12300000000000000")) throw new Error("typed amount not reflected");
  step("typed 0.0123 -> prompt uses 12300000000000000 wei");

  await page.locator(".field input").first().fill("0.0001");
  await page.getByText(/1 美元的最低支付|\$1 minimum/).waitFor();
  if (!(await prompt()).includes("<BNB>")) throw new Error("below-minimum amount leaked into the prompt");
  step("0.0001 -> below-minimum warning, prompt shows <BNB>");

  await page.locator(".field input").first().fill("0.01");
  await page.locator(".field input").nth(1).fill("nemo.ai");
  await page.getByText(/本轮剩余|left this round/).waitFor();
  step("nemo.ai -> handle, wallet and remaining allowance");

  await page.locator(".field input").nth(1).fill("thisnamedoesnotexist123.ai");
  await page.getByText(/没有找到这个 \.ai 名称|No such \.ai name/).waitFor();
  step("unknown .ai name -> clear message");

  await page.locator(".field input").nth(1).fill("0x000000000000000000000000000000000000dEaD");
  await page.getByText(/没有 \.ai Agent ID|holds no \.ai Agent ID/).waitFor();
  step("wallet without an Agent ID -> clear message");

  await page.locator(".code-h button").first().click();
  await page.getByText(/已复制|Copied/).first().waitFor();
  step("copy button works");
  console.log("PASS");
} catch (e) {
  await page.screenshot({ path: "e2e/planner-failure.png", fullPage: true }).catch(() => {});
  console.log("FAIL:", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
