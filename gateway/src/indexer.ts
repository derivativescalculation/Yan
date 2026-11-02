import { getAddress, type AbiEvent, type Address, type Hex } from "viem";
import { env } from "./config";
import { client, logsClient, TOKEN, MINTER, RAFFLE, minterAbi, tokenAbi, raffleAbi, pairAddress, memo } from "./chain";

/**
 * Follows the token, the minter and the raffle from DEPLOY_BLOCK, CONFIRMATIONS behind the head.
 * Keeps every holder's balance history (one point per transfer), the mints, the pot inflows and the
 * draws. Ticket lists are built from this history, so nothing is committed before the scan has caught up.
 */

const ZERO = "0x0000000000000000000000000000000000000000";
const lc = (a: string) => a.toLowerCase();

export interface BalPoint {
  block: bigint;
  idx: number;
  bal: bigint;
}

export interface Mint {
  agent: Address;
  handle: string;
  usd: bigint;
  total: bigint;
  toAgent: bigint;
  weiPaid: bigint;
  block: bigint;
  tx: Hex;
}

export interface Inflow {
  kind: "mint" | "sell";
  wallet: Address;
  amount: bigint; // YAN minted (all shares) or sold
  toPots: bigint; // the share that landed in the raffle
  block: bigint;
  tx: Hex;
}

export interface DrawRec {
  id: number;
  pot: number;
  status: "committed" | "random" | "settled" | "void";
  snapshotBlock: bigint;
  root: Hex | null;
  totalTickets: bigint;
  prize: bigint;
  requestId: bigint;
  random: bigint | null;
  winningTicket: bigint | null;
  winner: Address | null;
  commitTx: Hex;
  commitBlock: bigint;
  settleTx: Hex | null;
  settleBlock: bigint | null;
}

export const idx = {
  indexedTo: env.DEPLOY_BLOCK - 1n,
  caughtUp: false,
  pair: "",
  hist: new Map<string, BalPoint[]>(),
  mints: [] as Mint[],
  inflows: [] as Inflow[],
  draws: new Map<number, DrawRec>(),
};

const events = ([...tokenAbi, ...minterAbi, ...raffleAbi] as readonly { type: string }[]).filter((x) => x.type === "event") as AbiEvent[];

function move(addr: string, delta: bigint, block: bigint, logIndex: number) {
  const k = lc(addr);
  const h = idx.hist.get(k) ?? [];
  const last = h.length ? h[h.length - 1].bal : 0n;
  h.push({ block, idx: logIndex, bal: last + delta });
  idx.hist.set(k, h);
}

function apply(logs: any[]) {
  const token = lc(TOKEN), minter = lc(MINTER), raffle = lc(RAFFLE);
  for (let k = 0; k < logs.length; k++) {
    const l = logs[k];
    const at = lc(l.address), a = l.args, block = l.blockNumber as bigint, tx = l.transactionHash as Hex;
    if (at === token && l.eventName === "Transfer") {
      const value = a.value as bigint;
      if (lc(a.from) !== ZERO) move(a.from, -value, block, l.logIndex);
      if (lc(a.to) !== ZERO) move(a.to, value, block, l.logIndex);
      // the token emits the 0.5% to the raffle first, then the rest into the pair
      const next = logs[k + 1];
      if (lc(a.to) === raffle && lc(a.from) !== ZERO && next && next.transactionHash === tx && next.eventName === "Transfer" &&
          lc(next.args.from) === lc(a.from) && lc(next.args.to) === idx.pair) {
        idx.inflows.push({ kind: "sell", wallet: getAddress(a.from), amount: value + (next.args.value as bigint), toPots: value, block, tx });
      }
    } else if (at === minter && l.eventName === "Mined") {
      const total = a.tokensMinted as bigint, toAgent = a.toAgent as bigint, toVault = (total * 2500n) / 10_000n;
      idx.mints.push({ agent: getAddress(a.agent), handle: a.handle, usd: a.usdAmount18, total, toAgent, weiPaid: a.weiPaid, block, tx });
      idx.inflows.push({ kind: "mint", wallet: getAddress(a.agent), amount: total, toPots: total - toAgent - toVault, block, tx });
    } else if (at === raffle) {
      const id = Number(a.id);
      const d = idx.draws.get(id);
      switch (l.eventName) {
        case "DrawCommitted":
        case "DrawVoid":
          idx.draws.set(id, {
            id, pot: Number(a.pot), status: l.eventName === "DrawVoid" ? "void" : "committed", snapshotBlock: a.snapshotBlock,
            root: a.root ?? null, totalTickets: a.totalTickets ?? 0n, prize: a.prize ?? 0n, requestId: a.requestId ?? 0n,
            random: null, winningTicket: null, winner: null, commitTx: tx, commitBlock: block, settleTx: null, settleBlock: null,
          });
          break;
        case "DrawRandom":
          if (d) Object.assign(d, { status: "random", random: a.random, winningTicket: a.winningTicket });
          break;
        case "DrawRetried":
          if (d) d.requestId = a.requestId;
          break;
        case "DrawSettled":
          if (d) Object.assign(d, { status: "settled", winner: getAddress(a.winner), winningTicket: a.winningTicket, settleTx: tx, settleBlock: block });
          break;
      }
    }
  }
}

let running = false;
const STEP_MAX = 5_000n;

export async function tick() {
  if (running) return;
  running = true;
  try {
    if (!idx.pair) idx.pair = lc(await pairAddress());
    const head = (await logsClient.getBlockNumber()) - env.CONFIRMATIONS;
    let step = STEP_MAX;
    let from = idx.indexedTo + 1n;
    while (from <= head) {
      const to = from + step - 1n > head ? head : from + step - 1n;
      let logs;
      try {
        logs = await logsClient.getLogs({ address: [TOKEN, MINTER, RAFFLE], events, fromBlock: from, toBlock: to });
      } catch (e) {
        if (step <= 50n) throw e;
        step /= 2n;
        continue;
      }
      apply(logs);
      idx.indexedTo = to; // commit progress per window so a later failure never rescans or double-counts
      from = to + 1n;
      if (step < STEP_MAX) step *= 2n;
    }
    idx.caughtUp = true;
  } catch (e) {
    console.error("indexer:", (e as Error).message);
  } finally {
    running = false;
  }
}

export function startIndexer(everyMs = 3_000) {
  const loop = async () => {
    await tick();
    setTimeout(loop, everyMs);
  };
  loop();
}

export function balanceOf(addr: string): bigint {
  const h = idx.hist.get(lc(addr));
  return h && h.length ? h[h.length - 1].bal : 0n;
}

/** lowest balance from the start of block `from` through the end of block `to` */
export function minBalance(h: BalPoint[], from: bigint, to: bigint): bigint {
  let i = 0, before = 0n;
  while (i < h.length && h[i].block < from) before = h[i++].bal;
  let low = before;
  for (; i < h.length && h[i].block <= to; i++) if (h[i].bal < low) low = h[i].bal;
  return low;
}

export async function blockTime(n: bigint): Promise<number> {
  return memo(`ts:${n}`, 24 * 3600_000, async () => Number((await client.getBlock({ blockNumber: n })).timestamp));
}

/** first block at or after unix time `t`, searching (lo, hi] */
export async function firstBlockAtOrAfter(t: number, hi: bigint): Promise<bigint> {
  let lo = env.DEPLOY_BLOCK > 0n ? env.DEPLOY_BLOCK : 0n;
  if ((await blockTime(lo)) >= t) return lo;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if ((await blockTime(mid)) >= t) hi = mid;
    else lo = mid;
  }
  return hi;
}
