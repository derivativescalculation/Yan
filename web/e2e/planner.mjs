// Functional check of the mint planner on a live site (read-only: nothing is sent).
//   SITE=https://yansuan.io node e2e/planner.mjs
import { chromium } from "playwright";

const SITE = process.env.SITE ?? "https://yansuan.io";
const step = (s) => console.log("•", s);
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
page.setDefaultTimeout(45_000);
const codeText = async (i) => (await page.locator(".code pre").nth(i).innerText()).trim();

try {
  await page.goto(`${SITE}/mine`, { waitUntil: "load" });
  await page.locator(".kvl").getByText(/YAN\/USD/).waitFor();
  await page.waitForTimeout(3000);

  await page.locator(".chips button", { hasText: /^0\.05$/ }).click();
  await page.locator(".field input").nth(1).fill("401787");
  await page.getByText(/所有者|Owner/).first().waitFor();
  await page.waitForTimeout(2500);
  let mcp = await codeText(0);
  let cast = await codeText(1);
  if (!mcp.includes('"bnb": "0.05"')) throw new Error("MCP call not filled with 0.05: " + mcp);
  if (!cast.includes("--value 0.05ether") || !cast.includes(" 401787 ")) throw new Error("cast command not filled: " + cast);
  const kv = await page.locator(".kvl").innerText();
  if (!/\d+\.\d\d USD/.test(kv) || !/\d[\d,]* YAN/.test(kv)) throw new Error("calculator values missing: " + kv);
  step(`preset 0.05 + agent 401787 -> commands filled; ${kv.split("\n").slice(0, 4).join(" | ")}`);

  await page.locator(".field input").first().fill("0.2345");
  await page.waitForTimeout(2000);
  cast = await codeText(1);
  if (!cast.includes("--value 0.2345ether")) throw new Error("typed amount not reflected: " + cast);
  step("typed 0.2345 -> command uses 0.2345");

  await page.locator(".field input").first().fill("0.0001");
  await page.waitForTimeout(1500);
  await page.getByText(/1 美元的最低支付|\$1 minimum/).waitFor();
  mcp = await codeText(0);
  if (!mcp.includes("<BNB>")) throw new Error("below-minimum amount leaked into command: " + mcp);
  step("0.0001 -> below-minimum warning, command shows <BNB>");

  await page.locator(".field input").first().fill("abc");
  await page.getByText(/有效的 BNB|valid BNB/).waitFor();
  step("invalid text -> validation message");

  await page.locator(".field input").nth(1).fill("999999999999");
  await page.getByText(/没有这个 agentId|not in the registry/).waitFor();
  step("unknown agentId -> registry warning");

  await page.locator(".field input").first().fill("0.01");
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
