// Browser end-to-end against a local anvil chain.
// The site is read-only: no wallet. An agent mines by sending a transaction from its own runtime
// (simulated here with anvil's unlocked account 0, which owns agent #1), and the site must reflect it.
//   bun run dev:anvil   (VITE_CHAIN_ID=31337 via .env.anvil)   then   SITE=http://127.0.0.1:5174 bun run e2e
import { chromium } from "playwright";
import { encodeFunctionData, parseEther } from "viem";
import fs from "node:fs";

const SITE = process.env.SITE ?? "http://127.0.0.1:5174";
const RPC = "http://127.0.0.1:8545";
const AGENT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const NOT_AGENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const dep = JSON.parse(fs.readFileSync(new URL("../src/deployments/31337.json", import.meta.url), "utf8"));
const mineAbi = [{ type: "function", name: "mine", stateMutability: "payable", inputs: [{ name: "agentId", type: "uint256" }], outputs: [{ type: "uint256" }] }];

let rid = 1;
async function rpc(method, params = []) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: rid++, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
async function agentMine(from, bnb) {
  const data = encodeFunctionData({ abi: mineAbi, functionName: "mine", args: [1n] });
  const hash = await rpc("eth_sendTransaction", [{ from, to: dep.proofOfInference, data, value: "0x" + parseEther(bnb).toString(16) }]);
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

try {
  await page.goto(`${SITE}/mine`, { waitUntil: "load" });
  await page.getByText(/chain 31337/).first().waitFor({ timeout: 20000 });
  step("mine page loaded on the local chain");

  const walletButtons = await page.getByRole("button", { name: /连接钱包|Connect wallet|Disconnect/ }).count();
  if (walletButtons !== 0) throw new Error("wallet button still present");
  step("no wallet connection anywhere on the page");

  await page.getByText(/yansuan_register/).first().waitFor();
  await page.getByText(new RegExp(dep.proofOfInference)).first().waitFor();
  step("agent guide shows the MCP config with the live minter address");

  const minedBefore = await rpc("eth_call", [{ to: dep.proofOfInference, data: "0xa2309ff8" }, "latest"]).catch(() => "0x");
  const fresh = !minedBefore || BigInt(minedBefore === "0x" ? 0 : minedBefore) === 0n;
  if (fresh) {
    // $700/BNB mock feed: 0.01 BNB = $7 -> 280,000 YAN at 40,000/USD (only true before any mint)
    await page.getByText(/7\.00 USD/).first().waitFor({ timeout: 20000 });
    await page.getByText(/280,000 YAN/).first().waitFor({ timeout: 20000 });
    step("calculator: 0.01 BNB = 7.00 USD = 280,000 YAN");
  } else {
    await page.getByText(/7\.00 USD/).first().waitFor({ timeout: 20000 });
    step("calculator: 0.01 BNB = 7.00 USD");
  }

  await page.locator(".panel input").fill("0.001");
  await page.getByText(/1 美元的最低支付|\$1 minimum/).first().waitFor({ timeout: 10000 });
  step("calculator warns below the $1 minimum");

  let rejected = false;
  try {
    rejected = (await agentMine(NOT_AGENT, "0.01")) === "0x0"; // mined but reverted
  } catch (e) {
    rejected = /revert/i.test(e.message); // rejected at submission
  }
  if (!rejected) throw new Error("non-operator mine was not rejected");
  step("contract rejects a mine from a non-operator wallet");

  const status = await agentMine(AGENT, "0.01");
  if (status !== "0x1") throw new Error("agent mine failed");
  step("agent #1 mined 0.01 BNB from its own runtime");

  await page.reload({ waitUntil: "load" });
  await page.getByRole("link", { name: "#1" }).first().waitFor({ timeout: 30000 });
  await page.getByText(/0\.0100/).first().waitFor({ timeout: 30000 });
  step("leaderboard and feed show agent #1 with a 0.0100 BNB mint");

  await page.goto(`${SITE}/agent/1`, { waitUntil: "load" });
  await page.locator(".agent-id").getByText("#1").waitFor({ timeout: 30000 });
  await page.getByText(/万 *YAN|K *YAN|YAN/).first().waitFor({ timeout: 30000 });
  step("agent page renders agent #1");

  await page.goto(`${SITE}/treasury`, { waitUntil: "load" });
  await page.getByText(/BNB/).first().waitFor({ timeout: 30000 });
  const burner = BigInt(await rpc("eth_getBalance", [dep.burner, "latest"]));
  const shown = (Number(burner) / 1e18).toFixed(4);
  await page.getByText(new RegExp(shown.replace(".", "\\."))).first().waitFor({ timeout: 30000 });
  step(`treasury shows ${shown} BNB in the burner (20% of all payments)`);

  const real = errors.filter((e) => !/favicon|ERR_CONNECTION_REFUSED|net::|8787/.test(e));
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
