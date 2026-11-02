// Browser end-to-end: connect wallet, approve, mine, redeem, stake, check the agent page.
// Runs against a local anvil chain with a scripted EIP-1193 wallet (anvil account 0 is unlocked).
//   node e2e/mine.mjs  (expects vite on :5174 with VITE_CHAIN_ID=31337 and anvil on :8545)
import { chromium } from "playwright";

const SITE = process.env.SITE ?? "http://127.0.0.1:5174";
const RPC = "http://127.0.0.1:8545";
const ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

const provider = `
(() => {
  const RPC = ${JSON.stringify(RPC)}; const ADDR = ${JSON.stringify(ADDR)};
  let id = 1; const listeners = {};
  async function rpc(method, params) {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params: params ?? [] }) });
    const j = await r.json(); if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; throw e; } return j.result;
  }
  const eth = {
    isMetaMask: true,
    request: async ({ method, params }) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [ADDR];
      if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
      if (method === "wallet_requestPermissions" || method === "wallet_getPermissions") return [{ parentCapability: "eth_accounts" }];
      if (method === "eth_sendTransaction") { const tx = { ...params[0], from: ADDR }; return rpc("eth_sendTransaction", [tx]); }
      return rpc(method, params);
    },
    on: (ev, fn) => { (listeners[ev] ||= []).push(fn); },
    removeListener: (ev, fn) => { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); },
  };
  window.ethereum = eth;
  window.addEventListener("eip6963:requestProvider", () => {
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info: { uuid: "test-wallet", name: "Test Wallet", icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>", rdns: "io.yansuan.test" }, provider: eth }) }));
  });
})();`;

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
await page.addInitScript(provider);

const step = (s) => console.log("•", s);
try {
  await page.goto(`${SITE}/mine`, { waitUntil: "load" });
  step("mine page loaded");

  await page.getByText(/chain 31337/).first().waitFor({ timeout: 20000 });
  step("site is on the local chain");
  const connect = page.getByRole("button", { name: /连接钱包|Connect/ }).first();
  if (await connect.isVisible().catch(() => false)) await connect.click();
  await page.getByText(/0xf39F…2266/).first().waitFor({ timeout: 20000 });
  step("wallet connected");

  const panel = page.locator(".panel").first();
  await panel.locator("input").nth(0).fill("1");
  await panel.locator("input").nth(1).fill("10");
  await panel.getByText(/400,000 YAN/).waitFor({ timeout: 20000 });
  step("quote shows 400,000 YAN for 10 USD");

  await panel.getByRole("button", { name: /授权 10|Approve 10/ }).click();
  const mineBtn = panel.getByRole("button", { name: /支付并铸造|Pay and mint/ });
  await page.waitForFunction((sel) => { const b = [...document.querySelectorAll(sel + " button")].find((x) => /支付并铸造|Pay and mint/.test(x.textContent)); return b && !b.disabled; }, ".panel", { timeout: 30000 });
  step("approve confirmed, mine button enabled");

  await mineBtn.click();
  await panel.getByText(/^mined ·/).waitFor({ timeout: 60000 });
  step("mine succeeded on-chain");

  const p2 = page.locator(".panel").nth(1);
  await p2.locator("input").nth(0).fill("1");
  await p2.locator("input").nth(1).fill("100000");
  await p2.getByText(/兑换额度|Redeem credit/).waitFor();
  await p2.getByRole("button", { name: /授权 · redeem|Approve · redeem/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll(".panel")][1].querySelector("button") && /销毁换算力|Redeem/.test([...document.querySelectorAll(".panel")][1].querySelectorAll("button")[0].textContent), null, { timeout: 30000 });
  await p2.getByRole("button", { name: /销毁换算力|^Redeem$/ }).click();
  await p2.getByText(/^redeemed ·/).waitFor({ timeout: 60000 });
  step("redeem succeeded");

  await p2.getByRole("button", { name: /授权 · stake|Approve · stake/ }).click();
  await page.waitForFunction(() => { const bs = [...[...document.querySelectorAll(".panel")][1].querySelectorAll("button")]; return bs.some((b) => /^质押$|^Stake$/.test(b.textContent.trim()) && !b.disabled); }, null, { timeout: 30000 });
  await p2.getByRole("button", { name: /^质押$|^Stake$/ }).click();
  await p2.getByText(/^staked ·/).waitFor({ timeout: 60000 });
  step("stake succeeded");

  await page.goto(`${SITE}/agent/1`, { waitUntil: "load" });
  await page.getByText(/40\.0万|400\.0K/).first().waitFor({ timeout: 30000 });
  await page.getByText(/10\.0万|100\.0K/).first().waitFor({ timeout: 30000 });
  step("agent page shows 40.0万 mined and 10.0万 staked");

  await page.goto(`${SITE}/mine`, { waitUntil: "load" });
  await page.getByRole("link", { name: "#1" }).first().waitFor({ timeout: 30000 });
  step("leaderboard lists agent #1");

  // negative path: a wallet that does not operate agent 1 must see the error
  const page2 = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
  await page2.addInitScript(provider.replace(ADDR, "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"));
  await page2.goto(`${SITE}/mine`, { waitUntil: "load" });
  const c2 = page2.getByRole("button", { name: /连接钱包|Connect/ }).first();
  if (await c2.isVisible().catch(() => false)) await c2.click();
  await page2.getByText(/0x7099…79C8/).first().waitFor({ timeout: 20000 });
  await page2.locator(".panel").first().locator("input").nth(0).fill("1");
  await page2.getByText(/not an operator of agent 1/).waitFor({ timeout: 20000 });
  const disabled = await page2.getByRole("button", { name: /支付并铸造|Pay and mint/ }).isDisabled();
  step(`non-operator wallet: error shown, mine button disabled=${disabled}`);
  if (!disabled) throw new Error("mine button should be disabled for non-operator");

  const real = errors.filter((e) => !/favicon|ERR_CONNECTION_REFUSED|net::|8787/.test(e));
  if (real.length) { console.log("console/page errors:", real); throw new Error("page errors"); }
  console.log("PASS");
} catch (e) {
  await page.screenshot({ path: "e2e/failure.png", fullPage: true }).catch(() => {});
  console.log("FAIL:", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
