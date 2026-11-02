// Browser end-to-end against a local anvil chain + local gateway.
// The site is read-only. A .ai agent (anvil account 0 holds "genesis.ai" in the mock registry) mines by
// sending BNB to the minter from its own runtime; a wallet without an Agent ID must be rejected; the
// site must reflect everything.
//   anvil; forge script DeployLocal; gateway on :8787; bun run dev:anvil   then   SITE=… node e2e/mine.mjs
import { chromium } from "playwright";
import fs from "node:fs";

const SITE = process.env.SITE ?? "http://127.0.0.1:5174";
const RPC = "http://127.0.0.1:8545";
const AGENT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // genesis.ai
const NOT_AGENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const dep = JSON.parse(fs.readFileSync(new URL("../src/deployments/31337.json", import.meta.url), "utf8"));

let rid = 1;
async function rpc(method, params = []) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: rid++, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
async function sendBnb(from, wei) {
  const hash = await rpc("eth_sendTransaction", [{ from, to: dep.proofOfInference, value: "0x" + wei.toString(16) }]);
  for (let i = 0; i < 50; i++) {
    const rc = await rpc("eth_getTransactionReceipt", [hash]);
    if (rc) return rc.status;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("no receipt");
}

const step = (s) => console.log("•", s);
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
page.setDefaultNavigationTimeout(180000);
page.setDefaultTimeout(60000);
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
const prompt = async () => (await page.locator(".code pre").first().innerText()).trim();

try {
  await page.goto(`${SITE}/mine`, { waitUntil: "load" });
  await page.getByText(/chain 31337/).first().waitFor();
  step("mine page loaded on the local chain");

  if ((await page.getByRole("button", { name: /连接钱包|Connect wallet|Disconnect/ }).count()) !== 0) throw new Error("wallet button present");
  step("no wallet connection anywhere");

  await page.waitForTimeout(2500);
  let p = await prompt();
  if (!p.includes(dep.proofOfInference) || !p.includes("--value 10000000000000000") || !p.includes("0x99f4b251")) throw new Error("prompt not filled: " + p.slice(0, 300));
  step("prompt for 0.01 BNB has the minter, the wei value and mine() calldata");

  await page.locator(".chips button", { hasText: /^0\.02$/ }).click();
  await page.waitForTimeout(1500);
  p = await prompt();
  if (!p.includes("--value 20000000000000000")) throw new Error("preset not applied");
  step("preset 0.02 -> prompt updated");

  await page.locator(".field input").nth(1).fill("nobody.ai");
  await page.getByText(/没有找到这个 \.ai 名称|No such \.ai name/).waitFor();
  step("unknown .ai name -> clear message");

  await page.locator(".field input").nth(1).fill(NOT_AGENT);
  await page.getByText(/没有 \.ai Agent ID|holds no \.ai Agent ID/).waitFor();
  step("wallet without an Agent ID -> clear message");

  await page.locator(".chips button", { hasText: /^0\.01$/ }).click();
  await page.locator(".field input").nth(1).fill("genesis.ai");
  await page.getByText(/本纪元剩余|left this epoch/).waitFor();
  step("genesis.ai -> handle, wallet and remaining allowance shown");

  const rejected = (await sendBnb(NOT_AGENT, 10n ** 16n).catch(() => "0x0")) === "0x0";
  if (!rejected) throw new Error("non-agent send was not rejected");
  step("BNB sent from a wallet without an Agent ID is rejected by the contract");

  if ((await sendBnb(AGENT, 10n ** 16n)) !== "0x1") throw new Error("agent mine failed");
  step("genesis.ai mined by sending 0.01 BNB to the minter");

  await page.reload({ waitUntil: "load" });
  await page.getByRole("link", { name: "genesis.ai" }).first().waitFor();
  step("leaderboard and feed show genesis.ai");

  await page.goto(`${SITE}/agent/genesis.ai`, { waitUntil: "load" });
  await page.locator(".agent-id").getByText("genesis.ai").waitFor();
  await page.getByText(/本纪元剩余|Left this epoch/).waitFor();
  step("agent page resolves genesis.ai");

  await page.goto(`${SITE}/treasury`, { waitUntil: "load" });
  const burner = BigInt(await rpc("eth_getBalance", [dep.burner, "latest"]));
  const shown = (Number(burner) / 1e18).toFixed(4);
  await page.getByText(new RegExp(shown.replace(".", "\\."))).first().waitFor();
  step(`treasury shows ${shown} BNB in the burner`);

  const real = errors.filter((e) => !/favicon|ERR_CONNECTION_REFUSED|net::/.test(e));
  if (real.length) {
    console.log("console/page errors:", real);
    throw new Error("page errors");
  }
  console.log("PASS");
} catch (e) {
  await page.screenshot({ path: "e2e/failure.png", fullPage: true }).catch(() => {});
  console.log("FAIL:", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
