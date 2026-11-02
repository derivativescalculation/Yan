/**
 * 衍算 Yansuan inference gateway.
 *
 * Agents pay on-chain (ProofOfInference.mine / redeem) which credits their agentId.
 * This server meters Claude usage against that credit and proxies the request.
 */
import Anthropic from "@anthropic-ai/sdk";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { env, assertServerConfig } from "./config";
import { creditsUsd, stakedOf, stats, minedEvents, leaderboard, agentSeen } from "./chain";
import { ledger } from "./ledger";
import { ALLOWED_MODELS, chargedCost, rawCost, reserveFor, tierFor, fmtUsd, TIERS, assertSolvent } from "./pricing";
import { authenticate } from "./auth";

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

// ---------------------------------------------------------------- per-IP limiter for public reads

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

// ---------------------------------------------------------------- public

app.get("/", (c) =>
  c.json({
    name: "衍算 Yansuan Gateway",
    chainId: env.CHAIN_ID,
    contracts: { proofOfInference: env.POI_ADDRESS, token: env.TOKEN_ADDRESS, stake: env.STAKE_ADDRESS, registry: env.REGISTRY_ADDRESS },
    payment: "native BNB, valued in USD by the Chainlink BNB/USD feed",
    gatewayAgentId: env.GATEWAY_AGENT_ID?.toString() ?? null,
    models: ALLOWED_MODELS,
    tiers: json(TIERS),
    markupBps: env.MARKUP_BPS,
    maxInflight: env.MAX_INFLIGHT,
    auth: "x-agent-id, x-agent-address, x-agent-ts, x-agent-nonce, x-agent-sig = personal_sign(`yansuan:<chainId>:<agentId>:<ts>:<nonce>:<sha256(body)>`)",
    docs: `${env.PUBLIC_URL}/skill.md`,
  }),
);

app.get("/skill.md", async (c) => c.text(await Bun.file(new URL("../SKILL.md", import.meta.url)).text()));
app.get("/seal.svg", async (c) => {
  c.header("content-type", "image/svg+xml");
  return c.body(await Bun.file(new URL("../seal.svg", import.meta.url)).text());
});

/// ERC-8004 registration file for the gateway's own agent identity.
app.get("/agent.json", (c) =>
  c.json({
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "衍算 Yansuan Gateway",
    description: "Proof-of-Inference gateway on BNB Chain. Agents pay BNB for Claude inference; the payment mints $YAN. Only ERC-8004 agents can mint.",
    image: `${env.PUBLIC_URL}/seal.svg`,
    services: [
      { name: "web", endpoint: env.PUBLIC_URL },
      { name: "messages", endpoint: `${env.PUBLIC_URL}/v1/messages`, version: "anthropic-messages" },
      { name: "skill", endpoint: `${env.PUBLIC_URL}/skill.md` },
    ],
    active: true,
    registrations: env.GATEWAY_AGENT_ID ? [{ agentId: Number(env.GATEWAY_AGENT_ID), agentRegistry: `eip155:${env.CHAIN_ID}:${env.REGISTRY_ADDRESS}` }] : [],
    supportedTrust: ["reputation"],
  }),
);

app.get("/v1/stats", async (c) => {
  const [s, t] = await Promise.all([stats(), ledger.totals()]);
  return c.json(json({ ...s, gateway: t }));
});

app.get("/v1/leaderboard", async (c) => {
  const ev = await minedEvents();
  const agent = c.req.query("agent");
  if (agent !== undefined) {
    if (!/^\d{1,30}$/.test(agent)) return c.json({ error: "bad agent" }, 400);
    const id = BigInt(agent);
    return c.json(json({ agents: [], recent: ev.filter((e) => e.agentId === id).slice(-50).reverse() }));
  }
  return c.json(json({ agents: leaderboard(ev, 100), recent: ev.slice(-50).reverse() }));
});

app.get("/v1/agents/:id", async (c) => {
  const raw = c.req.param("id");
  if (!/^\d{1,30}$/.test(raw)) return c.json({ error: "bad id" }, 400);
  const agentId = BigInt(raw);
  const id = agentId.toString(); // canonical: "007" -> "7"
  if (!(await agentSeen(agentId))) return c.json({ error: "agent has no activity" }, 404);
  const [credit, used, staked, inflight] = await Promise.all([creditsUsd(agentId), ledger.usedUsd18(id), stakedOf(agentId), ledger.inflight(id)]);
  const tier = tierFor(staked);
  return c.json(
    json({
      agentId: id,
      creditUsd18: credit,
      usedUsd18: used,
      balanceUsd18: credit - used,
      balanceUsd: fmtUsd(credit - used),
      staked,
      tier: tier.name,
      discountBps: tier.discountBps,
      rpm: tier.rpm,
      inflight,
      recent: await ledger.recent(id, 20),
    }),
  );
});

// ---------------------------------------------------------------- metered inference

const CustomTool = z.object({ name: z.string(), input_schema: z.any(), description: z.string().optional(), type: z.literal("custom").optional() }).passthrough();
const Body = z.object({
  model: z.string().default(env.DEFAULT_MODEL),
  max_tokens: z.number().int().min(1).max(64_000).default(8_192),
  system: z.union([z.string(), z.array(z.any())]).optional(),
  messages: z.array(z.any()).min(1),
  stream: z.boolean().default(false),
  /// only client-side (custom) tools: server tools (web search, code execution) are billed per use by
  /// Anthropic and are not priced here, so they are refused
  tools: z.array(CustomTool).optional(),
  tool_choice: z.any().optional(),
  output_config: z.any().optional(),
  thinking: z.any().optional(),
  stop_sequences: z.array(z.string()).optional(),
  metadata: z.any().optional(),
});
const STREAM_REQUIRED_ABOVE = 8_000; // non-streaming responses above this exceed Bun's 255s idle timeout

// per-agent rpm windows (bounded)
const windows = new Map<string, number[]>();
function rateOk(agentId: string, rpm: number) {
  const now = Date.now();
  const w = (windows.get(agentId) ?? []).filter((t) => now - t < 60_000);
  if (w.length >= rpm) return false;
  w.push(now);
  windows.set(agentId, w);
  if (windows.size > 20_000) windows.delete(windows.keys().next().value!);
  return true;
}

// per-agent serialization of the check+reserve critical section
const locks = new Map<string, Promise<void>>();
async function withAgentLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(agentId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => (release = r));
  locks.set(agentId, prev.then(() => next));
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(agentId) === next) locks.delete(agentId);
  }
}

app.post("/v1/messages", async (c) => {
  const rawBody = await c.req.text();
  const auth = await authenticate(c.req.raw.headers, rawBody);
  if ("error" in auth) return c.json({ error: auth.error }, auth.status as any);
  const agentId = auth.agentId.toString();

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "body is not JSON" }, 400);
  }
  const parsed = Body.safeParse(parsedJson);
  if (!parsed.success) return c.json({ error: "bad body", issues: parsed.error.issues }, 400);
  const body = parsed.data;
  if (!ALLOWED_MODELS.includes(body.model)) return c.json({ error: `model must be one of ${ALLOWED_MODELS.join(", ")}` }, 400);
  if (!body.stream && body.max_tokens > STREAM_REQUIRED_ABOVE) return c.json({ error: `set stream:true for max_tokens > ${STREAM_REQUIRED_ABOVE}` }, 400);

  const staked = await stakedOf(auth.agentId);
  const tier = tierFor(staked);
  if (!rateOk(agentId, tier.rpm)) return c.json({ error: `rate limit ${tier.rpm}/min for tier ${tier.name}` }, 429);

  // pre-flight: count input tokens, reserve worst case
  let count: { input_tokens: number };
  try {
    count = await anthropic.messages.countTokens({ model: body.model, system: body.system as any, messages: body.messages, tools: body.tools as any });
  } catch (e) {
    return apiError(c, e);
  }
  const reserve = reserveFor(body.model, count.input_tokens, body.max_tokens, staked);
  const requestId = crypto.randomUUID();

  // critical section: balance check + reservation are atomic per agent
  const gate = await withAgentLock(agentId, async () => {
    const [credit, used, inflight] = await Promise.all([creditsUsd(auth.agentId), ledger.usedUsd18(agentId), ledger.inflight(agentId)]);
    if (inflight >= env.MAX_INFLIGHT) return { error: `max ${env.MAX_INFLIGHT} concurrent requests`, status: 429 as const };
    const balance = credit - used;
    if (balance < reserve) {
      return {
        error: "insufficient credit",
        status: 402 as const,
        balanceUsd: fmtUsd(balance),
        reserveUsd: fmtUsd(reserve),
        hint: `send BNB to ProofOfInference.mine(${agentId}) or redeem() YAN to top up`,
      };
    }
    await ledger.reserve(requestId, agentId, body.model, reserve);
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
