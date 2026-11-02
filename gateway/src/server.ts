/**
 * 衍算 Yansuan inference gateway.
 *
 * Binance .ai agents mint YAN by paying BNB to ProofOfInference; the payment books USD credit on the
 * agent's wallet. This server lets that wallet log in once (EIP-712) and spend the credit on metered
 * model inference.
 */
import Anthropic from "@anthropic-ai/sdk";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { parseEther, getAddress, type Address } from "viem";
import { env, assertServerConfig } from "./config";
import { creditsUsd, stakedOf, stats, minedEvents, leaderboard, handleOf, walletOfHandle, agentChain, quote, POI } from "./chain";
import { ledger } from "./ledger";
import { ALLOWED_MODELS, chargedCost, rawCost, reserveFor, tierFor, fmtUsd, TIERS, assertSolvent } from "./pricing";
import { authenticate, challenge, login } from "./auth";

assertServerConfig();
assertSolvent();

const anthropic = new Anthropic();
const app = new Hono();
app.use("*", cors());
app.onError((e, c) => {
  console.error(e);
  return c.json({ error: (e as Error).message }, 500);
});

const json = (o: unknown) => JSON.parse(JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
const key = (w: Address) => w.toLowerCase();

// ---------------------------------------------------------------- per-IP limiter for public endpoints

const ipHits = new Map<string, number[]>();
function ipOk(c: any, perMin = 120): boolean {
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

/** "nemo", "nemo.ai" or "0x…" -> { wallet, handle } */
async function resolveAgent(id: string): Promise<{ wallet: Address; handle: string } | null> {
  if (/^0x[0-9a-fA-F]{40}$/.test(id)) {
    const wallet = getAddress(id);
    return { wallet, handle: await handleOf(wallet) };
  }
  const wallet = await walletOfHandle(id);
  return wallet ? { wallet, handle: id.toLowerCase().replace(/\.ai$/, "") } : null;
}

// ---------------------------------------------------------------- public

app.get("/", (c) =>
  c.json({
    name: "衍算 Yansuan Gateway",
    chainId: env.CHAIN_ID,
    contracts: { proofOfInference: env.POI_ADDRESS, token: env.TOKEN_ADDRESS, stake: env.STAKE_ADDRESS, agentIdRegistry: env.AGENT_ID_REGISTRY_ADDRESS },
    identity: "Binance .ai Agent ID (SPACE ID). Only wallets holding one can mint.",
    payment: "native BNB, valued in USD by the Chainlink BNB/USD feed",
    models: ALLOWED_MODELS,
    tiers: json(TIERS),
    markupBps: env.MARKUP_BPS,
    maxInflight: env.MAX_INFLIGHT,
    login: "GET /v1/login/challenge?wallet=0x… then POST /v1/login with the EIP-712 signature; send Authorization: Bearer <token>",
    docs: `${env.PUBLIC_URL}/skill.md`,
  }),
);

app.get("/skill.md", async (c) => c.text(await Bun.file(new URL("../SKILL.md", import.meta.url)).text()));
app.get("/seal.svg", async (c) => {
  c.header("content-type", "image/svg+xml");
  return c.body(await Bun.file(new URL("../seal.svg", import.meta.url)).text());
});

app.get("/v1/stats", async (c) => {
  const [s, t] = await Promise.all([stats(), ledger.totals()]);
  return c.json(json({ ...s, gateway: t }));
});

app.get("/v1/leaderboard", async (c) => {
  const ev = await minedEvents();
  const agent = c.req.query("agent");
  if (agent !== undefined) {
    const a = await resolveAgent(agent);
    if (!a) return c.json({ agents: [], recent: [] });
    const k = key(a.wallet);
    return c.json(json({ agents: [], recent: ev.filter((e) => key(e.agent) === k).slice(-50).reverse() }));
  }
  return c.json(json({ agents: leaderboard(ev, 100), recent: ev.slice(-50).reverse() }));
});

/** What a payment mints right now, and whether this agent may mint it. */
app.get("/v1/quote", async (c) => {
  const bnb = c.req.query("bnb") ?? "";
  if (!/^\d*\.?\d+$/.test(bnb)) return c.json({ error: "bnb must be a decimal amount, e.g. 0.01" }, 400);
  const wei = parseEther(bnb);
  const s = await stats();
  const q = await quote(wei);
  const out: Record<string, unknown> = {
    bnb, wei, usd: fmtUsd(q.usd, 2), tokens: q.tokens, minimumUsd: fmtUsd(s.minPaymentUsd, 2),
    meetsMinimum: q.usd >= s.minPaymentUsd, contract: POI, value: wei, data: "0x99f4b251", // mine()
  };
  const agent = c.req.query("agent");
  if (agent) {
    const a = await resolveAgent(agent);
    if (!a) return c.json({ ...json(out), agent: null, canMine: false, reason: "no such .ai Agent ID" });
    const ch = await agentChain(a.wallet);
    const uncapped = ch.remaining > 10n ** 60n;
    const withinCap = uncapped || q.tokens <= ch.remaining;
    const isAgent = a.handle.length > 0;
    out.agent = { wallet: a.wallet, handle: a.handle ? `${a.handle}.ai` : null, remainingThisEpoch: uncapped ? null : ch.remaining };
    out.canMine = isAgent && withinCap && (out.meetsMinimum as boolean);
    out.reason = !isAgent ? "wallet has no .ai Agent ID" : !withinCap ? "exceeds this agent's remaining allowance for the epoch" : !out.meetsMinimum ? "below the $1 minimum" : null;
  }
  return c.json(json(out));
});

app.get("/v1/agents/:id", async (c) => {
  const a = await resolveAgent(c.req.param("id"));
  if (!a) return c.json({ error: "no such .ai Agent ID or address" }, 404);
  const k = key(a.wallet);
  const [credit, used, staked, inflight, ch] = await Promise.all([creditsUsd(a.wallet), ledger.usedUsd18(k), stakedOf(a.wallet), ledger.inflight(k), agentChain(a.wallet)]);
  const tier = tierFor(staked);
  const uncapped = ch.remaining > 10n ** 60n;
  return c.json(
    json({
      wallet: a.wallet,
      handle: a.handle ? `${a.handle}.ai` : null,
      isAgent: a.handle.length > 0,
      minedBy: ch.minedBy,
      remainingThisEpoch: uncapped ? null : ch.remaining,
      redeemedBy: ch.redeemedBy,
      creditUsd18: credit,
      usedUsd18: used,
      balanceUsd18: credit - used,
      balanceUsd: fmtUsd(credit - used),
      staked,
      tier: tier.name,
      discountBps: tier.discountBps,
      rpm: tier.rpm,
      inflight,
      recent: await ledger.recent(k, 20),
    }),
  );
});

// ---------------------------------------------------------------- login

app.get("/v1/login/challenge", (c) => {
  const w = c.req.query("wallet") ?? "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(w)) return c.json({ error: "wallet=0x… required" }, 400);
  return c.json(challenge(w as Address));
});

app.post("/v1/login", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const r = await login(body);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  return c.json(r);
});

// ---------------------------------------------------------------- metered inference

const CustomTool = z.object({ name: z.string(), input_schema: z.any(), description: z.string().optional(), type: z.literal("custom").optional() }).passthrough();
const Body = z.object({
  model: z.string().default(env.DEFAULT_MODEL),
  max_tokens: z.number().int().min(1).max(64_000).default(8_192),
  system: z.union([z.string(), z.array(z.any())]).optional(),
  messages: z.array(z.any()).min(1),
  stream: z.boolean().default(false),
  /// only client-side (custom) tools: server tools are billed per use upstream and are refused here
  tools: z.array(CustomTool).optional(),
  tool_choice: z.any().optional(),
  output_config: z.any().optional(),
  thinking: z.any().optional(),
  stop_sequences: z.array(z.string()).optional(),
  metadata: z.any().optional(),
});
const STREAM_REQUIRED_ABOVE = 8_000; // non-streaming responses above this exceed Bun's 255s idle timeout

const windows = new Map<string, number[]>();
function rateOk(k: string, rpm: number) {
  const now = Date.now();
  const w = (windows.get(k) ?? []).filter((t) => now - t < 60_000);
  if (w.length >= rpm) return false;
  w.push(now);
  windows.set(k, w);
  if (windows.size > 20_000) windows.delete(windows.keys().next().value!);
  return true;
}

// per-wallet serialization of the check+reserve critical section
const locks = new Map<string, Promise<void>>();
async function withLock<T>(k: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(k) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => (release = r));
  locks.set(k, prev.then(() => next));
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(k) === next) locks.delete(k);
  }
}

app.post("/v1/messages", async (c) => {
  const auth = authenticate(c.req.raw.headers);
  if ("error" in auth) return c.json({ error: auth.error }, auth.status as any);
  const wallet = auth.wallet;
  const k = key(wallet);

  const parsed = Body.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "bad body", issues: parsed.error.issues }, 400);
  const body = parsed.data;
  if (!ALLOWED_MODELS.includes(body.model)) return c.json({ error: `model must be one of ${ALLOWED_MODELS.join(", ")}` }, 400);
  if (!body.stream && body.max_tokens > STREAM_REQUIRED_ABOVE) return c.json({ error: `set stream:true for max_tokens > ${STREAM_REQUIRED_ABOVE}` }, 400);

  const staked = await stakedOf(wallet);
  const tier = tierFor(staked);
  if (!rateOk(k, tier.rpm)) return c.json({ error: `rate limit ${tier.rpm}/min for tier ${tier.name}` }, 429);

  let count: { input_tokens: number };
  try {
    count = await anthropic.messages.countTokens({ model: body.model, system: body.system as any, messages: body.messages, tools: body.tools as any });
  } catch (e) {
    return apiError(c, e);
  }
  const reserve = reserveFor(body.model, count.input_tokens, body.max_tokens, staked);
  const requestId = crypto.randomUUID();

  const gate = await withLock(k, async () => {
    const [credit, used, inflight] = await Promise.all([creditsUsd(wallet), ledger.usedUsd18(k), ledger.inflight(k)]);
    if (inflight >= env.MAX_INFLIGHT) return { error: `max ${env.MAX_INFLIGHT} concurrent requests`, status: 429 as const };
    const balance = credit - used;
    if (balance < reserve) {
      return {
        error: "insufficient credit",
        status: 402 as const,
        balanceUsd: fmtUsd(balance),
        reserveUsd: fmtUsd(reserve),
        hint: `mine with BNB (send BNB to ${POI} from your .ai agent wallet) or redeem YAN to top up`,
      };
    }
    await ledger.reserve(requestId, k, body.model, reserve);
    return null;
  });
  if (gate) return c.json(gate, gate.status);

  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: body.model,
    max_tokens: body.max_tokens,
    messages: body.messages,
    ...(body.system ? { system: body.system as any } : {}),
    ...(body.tools ? { tools: body.tools as any } : {}),
    ...(body.tool_choice ? { tool_choice: body.tool_choice } : {}),
    ...(body.output_config ? { output_config: body.output_config } : {}),
    ...(body.thinking ? { thinking: body.thinking } : {}),
    ...(body.stop_sequences ? { stop_sequences: body.stop_sequences } : {}),
  };

  const settle = async (msg: Anthropic.Message) => {
    const raw = rawCost(body.model, msg.usage);
    const cost = chargedCost(raw, staked);
    await ledger.settle(requestId, {
      inputTokens: msg.usage.input_tokens,
      outputTokens: msg.usage.output_tokens,
      cacheRead: msg.usage.cache_read_input_tokens ?? 0,
      cacheWrite: msg.usage.cache_creation_input_tokens ?? 0,
      costUsd18: cost,
      rawUsd18: raw,
    });
    return cost;
  };

  if (!body.stream) {
    try {
      const msg = await anthropic.messages.create(params);
      const cost = await settle(msg);
      c.header("x-yansuan-cost-usd", fmtUsd(cost, 6));
      c.header("x-yansuan-request-id", requestId);
      return c.json(msg);
    } catch (e) {
      await ledger.release(requestId);
      return apiError(c, e);
    }
  }

  return streamSSE(c, async (s) => {
    const stream = anthropic.messages.stream(params);
    try {
      for await (const ev of stream) await s.writeSSE({ event: ev.type, data: JSON.stringify(ev) });
      const msg = await stream.finalMessage();
      const cost = await settle(msg);
      await s.writeSSE({ event: "yansuan_settled", data: JSON.stringify({ requestId, costUsd: fmtUsd(cost, 6) }) });
    } catch (e: any) {
      await ledger.release(requestId);
      await s.writeSSE({ event: "error", data: JSON.stringify({ error: e?.message ?? "stream failed" }) });
    }
  });
});

function apiError(c: any, e: unknown) {
  if (e instanceof Anthropic.RateLimitError) return c.json({ error: "upstream rate limited" }, 503);
  if (e instanceof Anthropic.BadRequestError) return c.json({ error: e.message }, 400);
  if (e instanceof Anthropic.APIError) return c.json({ error: e.message }, 502);
  return c.json({ error: (e as Error)?.message ?? "unknown" }, 500);
}

export default { port: env.PORT, fetch: app.fetch, idleTimeout: 255 };
console.log(`衍算 gateway on :${env.PORT} chain ${env.CHAIN_ID} poi ${env.POI_ADDRESS} markup ${env.MARKUP_BPS}bps`);
