/**
 * 衍算 Yansuan gateway.
 *
 * Read API for the site and for agents: mint quotes, agents, the leaderboard and the 天选 raffle (pots,
 * live inflows, tickets, draws and every draw's published ticket list). With KEEPER_PRIVATE_KEY set it
 * also runs the raffle keeper.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { parseEther, getAddress, type Address } from "viem";
import { env, assertServerConfig, TICKET_UNIT } from "./config";
import { stats, pots, quote, agentReads, handleOf, walletOfHandle, MINTER, TOKEN, RAFFLE, VAULT, AGENT_IDS, memo } from "./chain";
import { idx, startIndexer, balanceOf, blockTime } from "./indexer";
import { ticketList, liveTickets, entryFor, type TicketList } from "./tickets";
import { proofFor } from "./merkle";
import { startKeeper, keeperAddress, keeperState } from "./keeper";

assertServerConfig();

const app = new Hono();
app.use("*", cors());
app.onError((e, c) => {
  console.error(e);
  return c.json({ error: (e as Error).message }, 500);
});

const json = (o: unknown) => JSON.parse(JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
const lc = (a: string) => a.toLowerCase();
const hex32 = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");

// ---------------------------------------------------------------- per-IP limiter

const ipHits = new Map<string, number[]>();
function ipOk(c: any, perMin = 240): boolean {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("cf-connecting-ip") || "local";
  const now = Date.now();
  const w = (ipHits.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (w.length >= perMin) return false;
  w.push(now);
  ipHits.set(ip, w);
  if (ipHits.size > 20_000) ipHits.delete(ipHits.keys().next().value!);
  return true;
}
app.use("/v1/*", async (c, next) => (ipOk(c) ? next() : c.json({ error: "too many requests" }, 429)));

/** "nemo", "nemo.ai" or "0x…" -> { wallet, handle }, null for an unknown .ai name */
async function resolve(id: string): Promise<{ wallet: Address; handle: string } | null> {
  if (/^0x[0-9a-fA-F]{40}$/.test(id)) {
    const wallet = getAddress(id);
    return { wallet, handle: await handleOf(wallet).catch(() => "") };
  }
  const wallet = await walletOfHandle(id);
  return wallet ? { wallet, handle: id.toLowerCase().replace(/\.ai$/, "") } : null;
}

const potSplit = (n: bigint) => {
  const a = (n * 4000n) / 10_000n, b = (n * 2000n) / 10_000n;
  return [a, b, n - a - b];
};

// ---------------------------------------------------------------- info

app.get("/", (c) =>
  c.json(json({
    name: "衍算 Yansuan Gateway",
    chainId: env.CHAIN_ID,
    contracts: { token: TOKEN, minter: MINTER, liquidityVault: VAULT, raffle: RAFFLE, agentIdRegistry: AGENT_IDS, pair: idx.pair || null },
    identity: "Binance .ai Agent ID. Only wallets holding one can mint.",
    mint: "send BNB to the minter or call mine(); 70% to the agent, 25% to the liquidity vault, 5% to the raffle; all BNB to the treasury",
    raffle: "one ticket per 10,000 YAN held (lowest balance in the hour before a draw); prizes are paid automatically",
    indexer: { indexedTo: idx.indexedTo, caughtUp: idx.caughtUp },
    keeper: keeperAddress ? { address: keeperAddress, ...keeperState } : null,
    docs: `${env.PUBLIC_URL}/skill.md`,
  })),
);

app.get("/skill.md", async (c) => c.text(await Bun.file(new URL("../SKILL.md", import.meta.url)).text()));
app.get("/seal.svg", async (c) => {
  c.header("content-type", "image/svg+xml");
  return c.body(await Bun.file(new URL("../seal.svg", import.meta.url)).text());
});

// ---------------------------------------------------------------- mint

app.get("/v1/stats", async (c) => {
  const [s, p, live] = await Promise.all([stats(), pots(), liveTickets().catch(() => null)]);
  const settled = [...idx.draws.values()].filter((d) => d.status === "settled").length;
  return c.json(json({ ...s, raffle: { paidOut: p.paidOut, drawsSettled: settled, holders: live?.entries.length ?? 0, totalTickets: live?.total ?? 0n }, indexedTo: idx.indexedTo }));
});

app.get("/v1/quote", async (c) => {
  const bnb = c.req.query("bnb") ?? "0.01";
  if (!/^\d+(\.\d{1,18})?$/.test(bnb)) return c.json({ error: "bnb must be a decimal amount, e.g. 0.01" }, 400);
  const wei = parseEther(bnb);
  if (wei === 0n || wei > parseEther("100")) return c.json({ error: "bnb must be between 0 and 100" }, 400);
  const [q, s] = await Promise.all([quote(wei), stats()]);
  const meetsMinimum = q.usd >= s.minPaymentUsd;
  let agent: { wallet: Address; handle: string | null; remainingThisEpoch: bigint | null } | null = null;
  let canMine = meetsMinimum && !s.paused && q.total > 0n;
  let reason: string | null = s.paused ? "minting is paused" : !meetsMinimum ? "payment is below the $1 minimum" : q.total === 0n ? "the 1B cap has been reached" : null;
  const id = c.req.query("agent");
  if (id) {
    const a = await resolve(id);
    if (!a) return c.json({ error: "no such .ai name" }, 404);
    const r = await agentReads(a.wallet);
    const capped = r.remaining !== 2n ** 256n - 1n;
    agent = { wallet: a.wallet, handle: a.handle || null, remainingThisEpoch: capped ? r.remaining : null };
    if (!a.handle) { canMine = false; reason = "wallet has no .ai Agent ID"; }
    else if (capped && q.total > r.remaining) { canMine = false; reason = "over this Agent ID's allowance for the epoch"; }
  }
  return c.json(json({
    bnb, wei, usd: q.usd, total: q.total, toAgent: q.toAgent, toVault: q.toVault, toRaffle: q.toRaffle,
    meetsMinimum, contract: MINTER, value: wei, data: "0x99f4b251", agent, canMine, reason,
  }));
});

app.get("/v1/leaderboard", async (c) => {
  const filter = c.req.query("agent");
  let wallet: string | null = null;
  if (filter) {
    const a = await resolve(filter);
    if (!a) return c.json({ error: "no such .ai name" }, 404);
    wallet = lc(a.wallet);
  }
  const by = new Map<string, { agent: Address; handle: string; toAgent: bigint; total: bigint; usd: bigint; txs: number; last: bigint }>();
  for (const m of idx.mints) {
    const row = by.get(lc(m.agent)) ?? { agent: m.agent, handle: m.handle, toAgent: 0n, total: 0n, usd: 0n, txs: 0, last: 0n };
    row.toAgent += m.toAgent; row.total += m.total; row.usd += m.usd; row.txs += 1;
    if (m.block > row.last) row.last = m.block;
    by.set(lc(m.agent), row);
  }
  const rows = [...by.values()].sort((a, b) => (b.total > a.total ? 1 : b.total < a.total ? -1 : 0)).slice(0, 50);
  const feed = idx.mints.filter((m) => !wallet || lc(m.agent) === wallet).slice(-60).reverse();
  return c.json(json({ rows, feed, indexedTo: idx.indexedTo }));
});

app.get("/v1/agents/:id", async (c) => {
  const a = await resolve(c.req.param("id"));
  if (!a) return c.json({ error: "no such .ai name" }, 404);
  const [r, live] = await Promise.all([agentReads(a.wallet), liveTickets().catch(() => null)]);
  const e = live?.entries.find((x) => lc(x.account) === lc(a.wallet));
  const capped = r.remaining !== 2n ** 256n - 1n;
  return c.json(json({
    wallet: a.wallet, handle: a.handle || null, isAgent: !!a.handle,
    minedBy: r.minedBy, remainingThisEpoch: capped ? r.remaining : null, balance: r.balance,
    tickets: e?.count ?? 0n, totalTickets: live?.total ?? 0n,
    mints: idx.mints.filter((m) => lc(m.agent) === lc(a.wallet)).slice(-40).reverse(),
    wins: [...idx.draws.values()].filter((d) => d.status === "settled" && d.winner && lc(d.winner) === lc(a.wallet)).reverse(),
  }));
});

// ---------------------------------------------------------------- raffle

async function winnerTickets(snapshot: bigint, winner: Address | null): Promise<bigint | null> {
  if (!winner) return null;
  const list = await ticketList(snapshot).catch(() => null);
  return list?.entries.find((x) => lc(x.account) === lc(winner))?.count ?? null;
}

app.get("/v1/raffle", async (c) => {
  const [p, live] = await Promise.all([pots(), liveTickets().catch(() => null)]);
  const all = [...idx.draws.values()].sort((a, b) => b.id - a.id);
  const draws = await Promise.all(
    all.filter((d) => d.status !== "void").slice(0, 40).map(async (d) => ({
      id: d.id, pot: d.pot, status: d.status, snapshotBlock: d.snapshotBlock, totalTickets: d.totalTickets, prize: d.prize,
      random: d.random === null ? null : hex32(d.random), winningTicket: d.winningTicket, winner: d.winner,
      handle: d.winner ? (await handleOf(d.winner).catch(() => "")) || null : null,
      winnerTickets: await winnerTickets(d.snapshotBlock, d.winner),
      commitTx: d.commitTx, settleTx: d.settleTx,
      settledAt: d.settleBlock ? await blockTime(d.settleBlock) : null,
    })),
  );
  return c.json(json({
    raffle: RAFFLE, token: TOKEN, ticketUnit: TICKET_UNIT,
    holders: live?.entries.length ?? 0, totalTickets: live?.total ?? 0n, ticketsAsOfBlock: live?.snapshotBlock ?? null,
    pots: p.pots, paidOut: p.paidOut, drawsSettled: all.filter((d) => d.status === "settled").length, draws,
  }));
});

app.get("/v1/raffle/feed", async (c) => {
  const events = await Promise.all(
    idx.inflows.slice(-30).reverse().map(async (f) => ({
      kind: f.kind, wallet: f.wallet, handle: (await handleOf(f.wallet).catch(() => "")) || null,
      amount: f.amount, adds: potSplit(f.toPots), block: f.block, tx: f.tx,
    })),
  );
  return c.json(json({ events }));
});

app.get("/v1/raffle/tickets/:id", async (c) => {
  const a = await resolve(c.req.param("id"));
  if (!a) return c.json({ error: "no such .ai name" }, 404);
  const live = await liveTickets();
  if (!live) return c.json({ error: "the indexer is still catching up" }, 503);
  const e = live.entries.find((x) => lc(x.account) === lc(a.wallet));
  return c.json(json({
    wallet: a.wallet, handle: a.handle || null, balance: balanceOf(a.wallet),
    minBalance: e?.minBalance ?? 0n, tickets: e?.count ?? 0n, totalTickets: live.total,
  }));
});

/** a draw and the full ticket list it was committed with, so anyone can rebuild the root */
app.get("/v1/raffle/draws/:id", async (c) => {
  const d = idx.draws.get(Number(c.req.param("id")));
  if (!d) return c.json({ error: "no such draw" }, 404);
  let list: TicketList | null = null;
  if (d.status !== "void") list = await ticketList(d.snapshotBlock);
  return c.json(json({
    draw: d,
    list: list && {
      snapshotBlock: list.snapshotBlock, windowStartBlock: list.windowStartBlock, windowSeconds: env.TICKET_WINDOW_SEC,
      ticketUnit: TICKET_UNIT, root: list.root, matchesCommittedRoot: list.root === d.root, total: list.total,
      leaf: "keccak256(keccak256(abi.encode(account, start, count)))", entries: list.entries,
    },
  }));
});

/** everything needed to call settle() yourself */
app.get("/v1/raffle/draws/:id/winner", async (c) => {
  const d = idx.draws.get(Number(c.req.param("id")));
  if (!d || d.random === null) return c.json({ error: "this draw has no random word yet" }, 404);
  const list = await ticketList(d.snapshotBlock);
  const ticket = d.random % d.totalTickets;
  const i = entryFor(list, ticket);
  if (i < 0) return c.json({ error: "ticket not found in the rebuilt list" }, 500);
  const e = list.entries[i];
  return c.json(json({ id: d.id, ticket, account: e.account, start: e.start, count: e.count, proof: proofFor(list.levels, i) }));
});

startIndexer();
startKeeper();

export default { port: env.PORT, fetch: app.fetch };
console.log(`gateway on :${env.PORT} chain ${env.CHAIN_ID}${keeperAddress ? ` keeper ${keeperAddress}` : ""}`);
