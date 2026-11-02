/**
 * Usage ledger. Credits live on-chain (ProofOfInference.creditsUsd); only *usage* is stored here.
 * balance = creditsUsd(agentId) - sum(usage incl. pending reservations).
 *
 * A request first RESERVES its worst-case cost (pending=1). Reservations count against the balance
 * immediately, so concurrent requests cannot all pass the same balance check. On completion the row
 * is settled to the actual cost; on upstream failure it is released.
 *
 * Postgres when DATABASE_URL is set (required outside the local chain), else bun:sqlite.
 *
 * Every row carries the chain id: agentIds are only unique per chain, and one database may serve
 * testnet and mainnet gateways.
 */
import { env } from "./config";

const CHAIN = env.CHAIN_ID;

export interface UsageRow {
  agentId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd18: bigint; // charged (or reserved while pending)
  rawUsd18: bigint; // provider bill
  requestId: string;
  pending: boolean;
  createdAt: number;
}

export interface Ledger {
  /** charged + pending reservations */
  usedUsd18(agentId: string): Promise<bigint>;
  inflight(agentId: string): Promise<number>;
  reserve(requestId: string, agentId: string, model: string, reserveUsd18: bigint): Promise<void>;
  settle(requestId: string, r: Omit<UsageRow, "agentId" | "model" | "requestId" | "pending" | "createdAt">): Promise<void>;
  release(requestId: string): Promise<void>;
  recent(agentId: string, limit: number): Promise<UsageRow[]>;
  totals(): Promise<{ requests: number; usedUsd18: bigint; rawUsd18: bigint; outputTokens: number }>;
}

const SCHEMA_COLS = `agent_id, model, input_tokens, output_tokens, cache_read, cache_write, cost_usd18, raw_usd18, request_id, pending, created_at`;

function mapRow(r: any): UsageRow {
  return {
    agentId: r.agent_id,
    model: r.model,
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    cacheRead: Number(r.cache_read),
    cacheWrite: Number(r.cache_write),
    costUsd18: BigInt(r.cost_usd18),
    rawUsd18: BigInt(r.raw_usd18),
    requestId: r.request_id,
    pending: Number(r.pending) === 1,
    createdAt: Number(r.created_at),
  };
}

// ---------------------------------------------------------------- sqlite (local only)

function sqliteLedger(): Ledger {
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
  const db = new Database(env.LEDGER_PATH);
  db.exec(`CREATE TABLE IF NOT EXISTS usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL, model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
    cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL,
    cost_usd18 TEXT NOT NULL, raw_usd18 TEXT NOT NULL,
    request_id TEXT NOT NULL UNIQUE, pending INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, chain_id INTEGER NOT NULL DEFAULT 0
  );`);
  try {
    db.exec(`ALTER TABLE usage ADD COLUMN chain_id INTEGER NOT NULL DEFAULT 0`);
  } catch {}
  db.exec(`CREATE INDEX IF NOT EXISTS usage_chain_agent ON usage(chain_id, agent_id);`);
  const ins = db.prepare(`INSERT INTO usage (${SCHEMA_COLS}, chain_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const upd = db.prepare(`UPDATE usage SET input_tokens=?, output_tokens=?, cache_read=?, cache_write=?, cost_usd18=?, raw_usd18=?, pending=0 WHERE request_id=?`);
  const del = db.prepare(`DELETE FROM usage WHERE request_id=? AND pending=1`);
  const sumQ = db.prepare(`SELECT cost_usd18 FROM usage WHERE chain_id=? AND agent_id=?`);
  const infQ = db.prepare(`SELECT COUNT(*) AS n FROM usage WHERE chain_id=? AND agent_id=? AND pending=1`);
  const rec = db.prepare(`SELECT * FROM usage WHERE chain_id=? AND agent_id=? AND pending=0 ORDER BY id DESC LIMIT ?`);
  const tot = db.prepare(`SELECT cost_usd18, raw_usd18, output_tokens FROM usage WHERE chain_id=? AND pending=0`);
  return {
    async usedUsd18(agentId) {
      let s = 0n;
      for (const r of sumQ.all(CHAIN, agentId) as any[]) s += BigInt(r.cost_usd18);
      return s;
    },
    async inflight(agentId) {
      return Number((infQ.get(CHAIN, agentId) as any).n);
    },
    async reserve(requestId, agentId, model, reserveUsd18) {
      ins.run(agentId, model, 0, 0, 0, 0, reserveUsd18.toString(), "0", requestId, 1, Date.now(), CHAIN);
    },
    async settle(requestId, r) {
      upd.run(r.inputTokens, r.outputTokens, r.cacheRead, r.cacheWrite, r.costUsd18.toString(), r.rawUsd18.toString(), requestId);
    },
    async release(requestId) {
      del.run(requestId);
    },
    async recent(agentId, limit) {
      return (rec.all(CHAIN, agentId, limit) as any[]).map(mapRow);
    },
    async totals() {
      let used = 0n, raw = 0n, out = 0, n = 0;
      for (const r of tot.all(CHAIN) as any[]) {
        used += BigInt(r.cost_usd18);
        raw += BigInt(r.raw_usd18);
        out += r.output_tokens;
        n += 1;
      }
      return { requests: n, usedUsd18: used, rawUsd18: raw, outputTokens: out };
    },
  };
}

// ---------------------------------------------------------------- postgres

async function pgLedger(url: string): Promise<Ledger> {
  const postgres = (await import("postgres")).default;
  const sql = postgres(url, { max: 5 });
  await sql`CREATE TABLE IF NOT EXISTS usage (
    id BIGSERIAL PRIMARY KEY,
    agent_id TEXT NOT NULL, model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
    cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL,
    cost_usd18 NUMERIC(40,0) NOT NULL, raw_usd18 NUMERIC(40,0) NOT NULL,
    request_id TEXT NOT NULL UNIQUE, pending SMALLINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL, chain_id INTEGER NOT NULL DEFAULT 0
  )`;
  // rows written before chain scoping existed came from the BSC testnet gateway
  await sql`ALTER TABLE usage ADD COLUMN IF NOT EXISTS chain_id INTEGER NOT NULL DEFAULT 97`;
  await sql`CREATE INDEX IF NOT EXISTS usage_chain_agent ON usage(chain_id, agent_id)`;
  return {
    async usedUsd18(agentId) {
      const [r] = await sql`SELECT COALESCE(SUM(cost_usd18),0)::text AS s FROM usage WHERE chain_id = ${CHAIN} AND agent_id = ${agentId}`;
      return BigInt(r.s);
    },
    async inflight(agentId) {
      const [r] = await sql`SELECT COUNT(*)::int AS n FROM usage WHERE chain_id = ${CHAIN} AND agent_id = ${agentId} AND pending = 1`;
      return r.n;
    },
    async reserve(requestId, agentId, model, reserveUsd18) {
      await sql`INSERT INTO usage (agent_id, model, input_tokens, output_tokens, cache_read, cache_write, cost_usd18, raw_usd18, request_id, pending, created_at, chain_id)
        VALUES (${agentId}, ${model}, 0, 0, 0, 0, ${reserveUsd18.toString()}::numeric, 0, ${requestId}, 1, ${Date.now()}, ${CHAIN})`;
    },
    async settle(requestId, r) {
      await sql`UPDATE usage SET input_tokens=${r.inputTokens}, output_tokens=${r.outputTokens}, cache_read=${r.cacheRead}, cache_write=${r.cacheWrite},
        cost_usd18=${r.costUsd18.toString()}::numeric, raw_usd18=${r.rawUsd18.toString()}::numeric, pending=0 WHERE request_id=${requestId}`;
    },
    async release(requestId) {
      await sql`DELETE FROM usage WHERE request_id=${requestId} AND pending=1`;
    },
    async recent(agentId, limit) {
      const rows = await sql`SELECT * FROM usage WHERE chain_id = ${CHAIN} AND agent_id = ${agentId} AND pending = 0 ORDER BY id DESC LIMIT ${limit}`;
      return rows.map(mapRow);
    },
    async totals() {
      const [r] = await sql`SELECT COUNT(*)::int AS n, COALESCE(SUM(cost_usd18),0)::text AS used,
        COALESCE(SUM(raw_usd18),0)::text AS raw, COALESCE(SUM(output_tokens),0)::int AS o FROM usage WHERE chain_id = ${CHAIN} AND pending = 0`;
      return { requests: r.n, usedUsd18: BigInt(r.used), rawUsd18: BigInt(r.raw), outputTokens: r.o };
    },
  };
}

let _ledger: Ledger | null = null;
async function getLedger(): Promise<Ledger> {
  if (!_ledger) _ledger = env.DATABASE_URL ? await pgLedger(env.DATABASE_URL) : sqliteLedger();
  return _ledger;
}
/** Lazily opened so that importing this module (e.g. from agent tools) never touches a database. */
export const ledger: Ledger = {
  usedUsd18: async (a) => (await getLedger()).usedUsd18(a),
  inflight: async (a) => (await getLedger()).inflight(a),
  reserve: async (r, a, m, u) => (await getLedger()).reserve(r, a, m, u),
  settle: async (r, x) => (await getLedger()).settle(r, x),
  release: async (r) => (await getLedger()).release(r),
  recent: async (a, l) => (await getLedger()).recent(a, l),
  totals: async () => (await getLedger()).totals(),
};
