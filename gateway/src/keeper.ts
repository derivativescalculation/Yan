import { createWalletClient, http, zeroHash, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { env } from "./config";
import { chain, client, RAFFLE, raffleAbi, mockVrfAbi } from "./chain";
import { idx, blockTime } from "./indexer";
import { ticketList, entryFor } from "./tickets";
import { proofFor } from "./merkle";

/**
 * Raffle keeper: one action per tick, in this order: settle a draw that has its random word, (local
 * chain only) answer the mock coordinator, commit a full pot, re-request a random word that never came,
 * and sync YAN that arrived from the sell tax. Every action is re-checked against chain state first.
 */

const account = env.KEEPER_PRIVATE_KEY ? privateKeyToAccount(env.KEEPER_PRIVATE_KEY as Hex) : null;
const wallet = account ? createWalletClient({ account, chain, transport: http(env.RPC_URL) }) : null;
const r = { address: RAFFLE, abi: raffleAbi } as const;

export const keeperAddress = account?.address ?? null;
export const keeperState = { lastAction: "", lastError: "", at: 0 };

async function send(functionName: "sync" | "commit" | "settle" | "retry", args: readonly unknown[], label: string) {
  const hash = await wallet!.writeContract({ ...r, functionName, args: args as any, chain, account: account! });
  const rc = await client.waitForTransactionReceipt({ hash, timeout: 90_000 });
  if (rc.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  keeperState.lastAction = `${label} ${hash}`;
  keeperState.at = Date.now();
  console.log("keeper:", label, hash);
}

const randomWord = () => {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return BigInt("0x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join(""));
};

let lastSync = 0;

async function step() {
  if (!wallet || !idx.caughtUp) return;

  // 1. settle
  for (const d of idx.draws.values()) {
    if (d.status !== "random") continue;
    const onchain = await client.readContract({ ...r, functionName: "draws", args: [BigInt(d.id)] });
    if (onchain[1] !== 2) continue; // already settled
    const list = await ticketList(d.snapshotBlock);
    if (list.root !== d.root || list.total !== d.totalTickets) {
      throw new Error(`draw ${d.id}: rebuilt list does not match the committed root`);
    }
    const ticket = onchain[7] % onchain[4];
    const i = entryFor(list, ticket);
    const e = list.entries[i];
    return send("settle", [BigInt(d.id), e.account, e.start, e.count, proofFor(list.levels, i)], `settle #${d.id}`);
  }

  // 2. local chain: the keeper answers the mock coordinator
  if (env.CHAIN_ID === 31337) {
    for (const d of idx.draws.values()) {
      if (d.status !== "committed") continue;
      const coordinator = await client.readContract({ ...r, functionName: "coordinator" });
      const hash = await wallet.writeContract({ address: coordinator, abi: mockVrfAbi, functionName: "fulfill", args: [d.requestId, randomWord()], chain, account: account! });
      await client.waitForTransactionReceipt({ hash });
      return;
    }
  }

  // 3. commit
  const pots = await Promise.all([0n, 1n, 2n].map((i) => client.readContract({ ...r, functionName: "pots", args: [i] })));
  for (let i = 0; i < 3; i++) {
    const [, , , fullAtBlock, , activeDraw] = pots[i];
    if (fullAtBlock === 0n || activeDraw !== 0n) continue;
    if (fullAtBlock > idx.indexedTo) continue; // wait until the snapshot block is indexed
    const list = await ticketList(fullAtBlock);
    if (list.total === 0n) {
      // nobody holds a ticket: restart the snapshot, at most every 10 minutes
      if (Date.now() / 1000 - (await blockTime(fullAtBlock)) < 600) continue;
      return send("commit", [BigInt(i), fullAtBlock, zeroHash, 0n], `void pot ${i}`);
    }
    return send("commit", [BigInt(i), fullAtBlock, list.root!, list.total], `commit pot ${i} (${list.entries.length} holders, ${list.total} tickets)`);
  }

  // 4. retry a random word that never arrived (the contract allows it after a day)
  for (const d of idx.draws.values()) {
    if (d.status !== "committed") continue;
    const onchain = await client.readContract({ ...r, functionName: "draws", args: [BigInt(d.id)] });
    if (onchain[1] === 1 && Date.now() / 1000 > Number(onchain[3]) + 86_400 + 60) return send("retry", [BigInt(d.id)], `retry #${d.id}`);
  }

  // 5. sync the sell tax, at most once a minute
  if (Date.now() - lastSync > 60_000) {
    const pending = await client.readContract({ ...r, functionName: "pending" });
    if (pending > 0n) {
      lastSync = Date.now();
      return send("sync", [], "sync");
    }
  }
}

export function startKeeper() {
  if (!wallet) return;
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await step();
      keeperState.lastError = "";
    } catch (e) {
      keeperState.lastError = (e as Error).message.slice(0, 300);
      console.error("keeper:", keeperState.lastError);
    } finally {
      busy = false;
    }
  }, env.KEEPER_INTERVAL_MS);
}
