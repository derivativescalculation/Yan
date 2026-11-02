/**
 * Genesis Agent: the first miner. Runs a public loop:
 *   1. if credit < floor, mine `MINE_BNB` on-chain
 *   2. run one inference through the gateway (a short protocol note in Chinese)
 *   3. sleep
 * Every action is on-chain or in the gateway ledger, so the launch story is verifiable.
 *
 *   bun --env-file=.env.genesis src/genesis.ts
 * Env: AGENT_PRIVATE_KEY, AGENT_ID, GATEWAY_URL, MINE_BNB (default 0.01), FLOOR_USD (default 1), INTERVAL_SEC (default 600)
 */
import type { Hex } from "viem";
import { mine, infer } from "./agentkit";
import { env } from "./config";

const pk = process.env.AGENT_PRIVATE_KEY as Hex;
const agentId = BigInt(process.env.AGENT_ID ?? "0");
const gateway = process.env.GATEWAY_URL ?? env.PUBLIC_URL;
const MINE_BNB = process.env.MINE_BNB ?? "0.01";
const FLOOR = BigInt(Math.round(Number(process.env.FLOOR_USD ?? "1") * 1e6)) * 10n ** 12n;
const INTERVAL = Number(process.env.INTERVAL_SEC ?? "600");

if (!pk || agentId === 0n) {
  console.error("AGENT_PRIVATE_KEY and AGENT_ID required");
  process.exit(1);
}

const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));

async function balance(): Promise<bigint> {
  const r = await fetch(`${gateway}/v1/agents/${agentId}`);
  const j = (await r.json()) as { balanceUsd18: string };
  return BigInt(j.balanceUsd18);
}

async function tick() {
  const bal = await balance();
  log({ step: "balance", usd18: bal.toString() });
  if (bal < FLOOR) {
    const r = await mine(pk, agentId, MINE_BNB);
    log({ step: "mine", bnb: MINE_BNB, tx: r.hash, status: r.status });
  }
  const stats = await (await fetch(`${gateway}/v1/stats`)).json();
  const r = await infer(gateway, pk, agentId, {
    model: "claude-haiku-5-5",
    max_tokens: 400,
    output_config: { effort: "low" },
    system: "你是衍算协议的创世矿工。用一句话、不超过60字、不用感叹号，陈述当前协议状态。只输出那句话。",
    messages: [{ role: "user", content: `协议统计 JSON：${JSON.stringify(stats)}` }],
  });
  const text = r.status === 200 ? (r.data.content as any[]).filter((b) => b.type === "text").map((b) => b.text).join("") : JSON.stringify(r.data);
  log({ step: "infer", status: r.status, cost: r.cost, text });
}

log({ step: "start", agentId: agentId.toString(), gateway, interval: INTERVAL });
for (;;) {
  try {
    await tick();
  } catch (e) {
    log({ step: "error", message: (e as Error).message });
  }
  await Bun.sleep(INTERVAL * 1000);
}
