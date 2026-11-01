import { env } from "./config";

/** USD per 1M tokens, first-party Claude API rates (cached 2026-10). */
interface Price { input: number; output: number; cacheRead: number; cacheWrite: number; longInput?: number; longOutput?: number; longFrom?: number }
export const MODELS: Record<string, Price> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  // Haiku 5.5 is 0.10/0.50 up to 100K prompt tokens, 0.50/2.50 beyond
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, longInput: 0.5, longOutput: 2.5, longFrom: 100_000 },
};

export const ALLOWED_MODELS = Object.keys(MODELS);

const E18 = 10n ** 18n;
const MTOK = 1_000_000n;

function perTokenWei(usdPerMtok: number): bigint {
  return (BigInt(Math.round(usdPerMtok * 1000)) * E18) / 1000n / MTOK;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** Raw provider cost in USD (1e18). */
export function rawCost(model: string, u: Usage): bigint {
  const p = MODELS[model];
  if (!p) throw new Error(`unknown model ${model}`);
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const promptTokens = u.input_tokens + cacheRead + cacheWrite;
  const long = p.longFrom !== undefined && promptTokens > p.longFrom;
  const input = long ? p.longInput! : p.input;
  const output = long ? p.longOutput! : p.output;
  const mult = long ? p.longInput! / p.input : 1;
  return (
    perTokenWei(input) * BigInt(u.input_tokens) +
    perTokenWei(output) * BigInt(u.output_tokens) +
    perTokenWei(p.cacheRead * mult) * BigInt(cacheRead) +
    perTokenWei(p.cacheWrite * mult) * BigInt(cacheWrite)
  );
}

/** Stake tiers: tokens staked against the agentId -> discount on the MARKUP (never on list price). */
export const TIERS: { name: string; min: bigint; discountBps: number; rpm: number }[] = [
  { name: "玄", min: 100_000_000n * E18, discountBps: 2500, rpm: 600 },
  { name: "金", min: 10_000_000n * E18, discountBps: 1500, rpm: 300 },
  { name: "银", min: 1_000_000n * E18, discountBps: 800, rpm: 120 },
  { name: "铜", min: 0n, discountBps: 0, rpm: 60 },
];
export const MAX_DISCOUNT_BPS = Math.max(...TIERS.map((t) => t.discountBps));

export function tierFor(staked: bigint) {
  return TIERS.find((t) => staked >= t.min) ?? TIERS[TIERS.length - 1];
}

/** What the agent is charged: raw * (1 + markup * (1 - discount)). */
export function chargedCost(raw: bigint, staked: bigint): bigint {
  const tier = tierFor(staked);
  const effMarkup = (BigInt(env.MARKUP_BPS) * BigInt(10_000 - tier.discountBps)) / 10_000n;
  return (raw * (10_000n + effMarkup)) / 10_000n;
}

/** Conservative pre-flight reserve: full max_tokens of output at the charged rate. */
export function reserveFor(model: string, inputTokens: number, maxTokens: number, staked: bigint): bigint {
  return chargedCost(rawCost(model, { input_tokens: inputTokens, output_tokens: maxTokens }), staked);
}

/**
 * Worst-case solvency: every agent spends all credit at the best discount and redeems every token.
 * Treasury share (1-burn) of revenue must cover raw cost: (1-burn)*(1+markup*(1-dMax)) >= (1+redeem)*(1+margin).
 * Throws at startup if the configured numbers do not hold with a 10% gross margin.
 */
export function assertSolvent() {
  const effMarkup = (env.MARKUP_BPS * (10_000 - MAX_DISCOUNT_BPS)) / 10_000;
  const revenue = (10_000 - env.BURN_BPS) * (10_000 + effMarkup);
  const liability = (10_000 + env.REDEEM_BPS) * 10_000;
  if (revenue * 100 < liability * 110) {
    throw new Error(
      `insolvent config: MARKUP_BPS=${env.MARKUP_BPS} BURN_BPS=${env.BURN_BPS} REDEEM_BPS=${env.REDEEM_BPS} maxDiscount=${MAX_DISCOUNT_BPS} (need (1-burn)(1+markup(1-d)) >= 1.1(1+redeem))`,
    );
  }
}

export function fmtUsd(wei: bigint, dp = 4): string {
  const neg = wei < 0n;
  const a = neg ? -wei : wei;
  const whole = a / E18;
  const frac = ((a % E18) * 10n ** BigInt(dp)) / E18;
  return `${neg ? "-" : ""}${whole}.${frac.toString().padStart(dp, "0")}`;
}
