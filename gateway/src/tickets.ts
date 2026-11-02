import { getAddress, type Address, type Hex } from "viem";
import { env, TICKET_UNIT } from "./config";
import { TOKEN, MINTER, RAFFLE, VAULT } from "./chain";
import { idx, minBalance, blockTime, firstBlockAtOrAfter } from "./indexer";
import { buildTree, leafHash, rootOf } from "./merkle";

/**
 * The ticket list for a snapshot block: every holder's lowest balance in the TICKET_WINDOW_SEC before the
 * snapshot, one ticket per 10,000 YAN, addresses in ascending order, consecutive ticket ranges. The same
 * inputs always give the same list, so a committed root can be rebuilt by anyone from public data.
 */

export interface TicketEntry {
  account: Address;
  start: bigint;
  count: bigint;
  minBalance: bigint;
}

export interface TicketList {
  snapshotBlock: bigint;
  windowStartBlock: bigint;
  total: bigint;
  root: Hex | null;
  entries: TicketEntry[];
  levels: Hex[][];
}

/** fixed by configuration so every gateway builds identical lists */
export function excluded(): Set<string> {
  const s = new Set(
    [
      "0x0000000000000000000000000000000000000000",
      "0x000000000000000000000000000000000000dead",
      TOKEN, MINTER, RAFFLE, VAULT, idx.pair,
      env.TREASURY_ADDRESS, env.DEPLOYER_ADDRESS,
      ...env.EXCLUDED_ADDRESSES.split(",").map((x) => x.trim()),
    ].filter(Boolean).map((x) => x.toLowerCase()),
  );
  return s;
}

const lists = new Map<string, TicketList>();

export async function ticketList(snapshot: bigint): Promise<TicketList> {
  if (snapshot > idx.indexedTo) throw new Error(`block ${snapshot} is not indexed yet`);
  const key = snapshot.toString();
  const hit = lists.get(key);
  if (hit) return hit;
  const ts = await blockTime(snapshot);
  const windowStart = await firstBlockAtOrAfter(ts - env.TICKET_WINDOW_SEC, snapshot);
  const skip = excluded();
  const entries: TicketEntry[] = [];
  let acc = 0n;
  for (const addr of [...idx.hist.keys()].sort()) {
    if (skip.has(addr)) continue;
    const low = minBalance(idx.hist.get(addr)!, windowStart, snapshot);
    const count = low / TICKET_UNIT;
    if (count === 0n) continue;
    entries.push({ account: getAddress(addr), start: acc, count, minBalance: low });
    acc += count;
  }
  const levels = buildTree(entries.map((e) => leafHash(e.account, e.start, e.count)));
  const list = { snapshotBlock: snapshot, windowStartBlock: windowStart, total: acc, root: rootOf(levels), entries, levels };
  if (lists.size > 500) lists.delete(lists.keys().next().value!);
  lists.set(key, list);
  return list;
}

/** the holder whose range contains `ticket` */
export function entryFor(list: TicketList, ticket: bigint): number {
  let lo = 0, hi = list.entries.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, e = list.entries[mid];
    if (ticket < e.start) hi = mid - 1;
    else if (ticket >= e.start + e.count) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** the list as of the indexed head, refreshed at most every 20 seconds (for display) */
let live: { at: number; list: TicketList } | null = null;
export async function liveTickets(): Promise<TicketList | null> {
  if (!idx.caughtUp) return null;
  if (live && Date.now() - live.at < 20_000) return live.list;
  const list = await ticketList(idx.indexedTo);
  live = { at: Date.now(), list };
  return list;
}
