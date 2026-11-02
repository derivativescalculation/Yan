import { createPublicClient, http, parseAbi, parseAbiItem, type Address } from "viem";
import { bsc, bscTestnet, foundry } from "viem/chains";
import { env } from "./config";
import PoiAbi from "./abi/ProofOfInference.json";
import StakeAbi from "./abi/SuanStake.json";
import TokenAbi from "./abi/SuanToken.json";

export const chain =
  env.CHAIN_ID === 56 ? bsc : env.CHAIN_ID === 97 ? bscTestnet : { ...foundry, id: env.CHAIN_ID, rpcUrls: { default: { http: [env.RPC_URL] } } };

export const client = createPublicClient({ chain, transport: http(env.RPC_URL) });
/** log scans go to an endpoint that serves eth_getLogs */
export const logsClient = createPublicClient({ chain, transport: http(env.LOGS_RPC_URL ?? env.RPC_URL) });

export const POI = env.POI_ADDRESS as Address;
export const TOKEN = env.TOKEN_ADDRESS as Address;
export const STAKE = env.STAKE_ADDRESS as Address;
export const AGENT_IDS = env.AGENT_ID_REGISTRY_ADDRESS as Address;

export const poiAbi = PoiAbi as any;
export const stakeAbi = StakeAbi as any;
export const tokenAbi = TokenAbi as any;

export const agentIdAbi = parseAbi([
  "function handleOf(address wallet) view returns (string)",
  "function ownerOfHandle(string handle) view returns (address)",
]);

// ---------------------------------------------------------------- bounded cache

const MAX_CACHE = 5_000;
const cache = new Map<string, { at: number; v: unknown }>();
async function memo<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v as T;
  const v = await fn(); // throws are not cached
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value!); // FIFO eviction
  cache.set(key, { at: Date.now(), v });
  return v;
}

const lc = (a: string) => a.toLowerCase();

/** .ai handle (without suffix) held by `wallet`, "" if none */
export async function handleOf(wallet: Address): Promise<string> {
  return memo(`handle:${lc(wallet)}`, 60_000, async () =>
    (await client.readContract({ address: AGENT_IDS, abi: agentIdAbi, functionName: "handleOf", args: [wallet] })) as string,
  );
}

/** wallet holding `handle` (accepts "nemo" or "nemo.ai"), null if unregistered */
export async function walletOfHandle(handle: string): Promise<Address | null> {
  const h = handle.toLowerCase().replace(/\.ai$/, "");
  if (!/^[a-z0-9]{1,64}$/.test(h)) return null;
  const a = await memo(`owner:${h}`, 60_000, async () =>
    (await client.readContract({ address: AGENT_IDS, abi: agentIdAbi, functionName: "ownerOfHandle", args: [h] })) as Address,
  );
  return a && !/^0x0{40}$/i.test(a) ? a : null;
}

export async function creditsUsd(wallet: Address): Promise<bigint> {
  return memo(`credits:${lc(wallet)}`, 5_000, async () =>
    (await client.readContract({ address: POI, abi: poiAbi, functionName: "creditsUsd", args: [wallet] })) as bigint,
  );
}

export async function stakedOf(wallet: Address): Promise<bigint> {
  return memo(`staked:${lc(wallet)}`, 30_000, async () =>
    (await client.readContract({ address: STAKE, abi: stakeAbi, functionName: "staked", args: [wallet] })) as bigint,
  );
}

export async function agentChain(wallet: Address) {
  const poi = { address: POI, abi: poiAbi } as const;
  const [minedBy, remaining, redeemedBy, seen] = await Promise.all([
    client.readContract({ ...poi, functionName: "minedBy", args: [wallet] }) as Promise<bigint>,
    client.readContract({ ...poi, functionName: "remainingThisEpoch", args: [wallet] }) as Promise<bigint>,
    client.readContract({ ...poi, functionName: "redeemedBy", args: [wallet] }) as Promise<bigint>,
    client.readContract({ ...poi, functionName: "seen", args: [wallet] }) as Promise<boolean>,
  ]);
  return { minedBy, remaining, redeemedBy, seen };
}

export interface ProtocolStats {
  chainId: number;
  totalMinted: bigint;
  totalUsdPaid: bigint;
  totalWeiPaid: bigint;
  totalRedeemed: bigint;
  agentCount: bigint;
  currentEpoch: bigint;
  tokensPerUsd: bigint;
  costToCap: bigint;
  bnbUsd: bigint;
  maxPerAgentPerEpoch: bigint;
  minPaymentUsd: bigint;
  totalSupply: bigint;
  totalStaked: bigint;
  cap: bigint;
}

export async function stats(): Promise<ProtocolStats> {
  return memo("stats", 10_000, async () => {
    const poi = { address: POI, abi: poiAbi } as const;
    const rd = (c: { address: Address; abi: any; functionName: string }) =>
      client.readContract({ address: c.address, abi: c.abi, functionName: c.functionName }) as Promise<bigint>;
    const [totalMinted, totalUsdPaid, totalWeiPaid, totalRedeemed, agentCount, currentEpoch, tokensPerUsd, costToCap, bnbUsd, maxPerAgentPerEpoch, minPaymentUsd, totalSupply, totalStaked, cap] =
      await Promise.all([
        rd({ ...poi, functionName: "totalMinted" }),
        rd({ ...poi, functionName: "totalUsdPaid" }),
        rd({ ...poi, functionName: "totalWeiPaid" }),
        rd({ ...poi, functionName: "totalRedeemed" }),
        rd({ ...poi, functionName: "agentCount" }),
        rd({ ...poi, functionName: "currentEpoch" }),
        rd({ ...poi, functionName: "tokensPerUsd" }),
        rd({ ...poi, functionName: "costToCap" }),
        rd({ ...poi, functionName: "bnbUsd" }),
        rd({ ...poi, functionName: "maxPerAgentPerEpoch" }),
        rd({ ...poi, functionName: "minPaymentUsd" }),
        rd({ address: TOKEN, abi: tokenAbi, functionName: "totalSupply" }),
        rd({ address: STAKE, abi: stakeAbi, functionName: "totalStaked" }),
        rd({ address: TOKEN, abi: tokenAbi, functionName: "CAP" }),
      ]);
    return { chainId: env.CHAIN_ID, totalMinted, totalUsdPaid, totalWeiPaid, totalRedeemed, agentCount, currentEpoch, tokensPerUsd, costToCap, bnbUsd, maxPerAgentPerEpoch, minPaymentUsd, totalSupply, totalStaked, cap };
  });
}

export async function quote(wei: bigint): Promise<{ tokens: bigint; usd: bigint }> {
  const [tokens, usd] = await Promise.all([
    client.readContract({ address: POI, abi: poiAbi, functionName: "quote", args: [wei] }) as Promise<bigint>,
    client.readContract({ address: POI, abi: poiAbi, functionName: "usdOf", args: [wei] }) as Promise<bigint>,
  ]);
  return { tokens, usd };
}

export interface MinedEvent {
  agent: Address;
  handle: string;
  usd: bigint;
  tokens: bigint;
  epochAfter: bigint;
  weiPaid: bigint;
  block: bigint;
  tx: `0x${string}`;
}

const minedAbi = parseAbiItem(
  "event Mined(address indexed agent, string handle, uint256 usdAmount18, uint256 tokensMinted, uint256 epochAfter, uint256 weiPaid)",
);

/// Mined events since DEPLOY_BLOCK, cached and extended incrementally. Single in-flight scan.
let minedCache: { upTo: bigint; events: MinedEvent[] } = { upTo: env.DEPLOY_BLOCK > 0n ? env.DEPLOY_BLOCK - 1n : 0n, events: [] };
let scanning: Promise<MinedEvent[]> | null = null;

export function minedEvents(): Promise<MinedEvent[]> {
  if (scanning) return scanning;
  scanning = (async () => {
    try {
      const head = await logsClient.getBlockNumber();
      if (head <= minedCache.upTo) return minedCache.events;
      // adaptive window: start wide, halve on a provider rejection, grow back after successes
      let step = 5_000n;
      let from = minedCache.upTo + 1n;
      while (from <= head) {
        const to = from + step - 1n > head ? head : from + step - 1n;
        let logs;
        try {
          logs = await logsClient.getLogs({ address: POI, event: minedAbi, fromBlock: from, toBlock: to });
        } catch (e) {
          if (step <= 100n) throw e;
          step /= 2n;
          continue;
        }
        const fresh: MinedEvent[] = [];
        for (const l of logs) {
          const a = l.args;
          fresh.push({ agent: a.agent!, handle: a.handle!, usd: a.usdAmount18!, tokens: a.tokensMinted!, epochAfter: a.epochAfter!, weiPaid: a.weiPaid!, block: l.blockNumber!, tx: l.transactionHash! });
        }
        // commit progress per window so a later failure never rescans or double-counts
        minedCache = { upTo: to, events: [...minedCache.events, ...fresh] };
        from = to + 1n;
        if (step < 5_000n) step *= 2n;
      }
      return minedCache.events;
    } finally {
      scanning = null;
    }
  })();
  return scanning;
}

export function leaderboard(events: MinedEvent[], limit = 50) {
  const by = new Map<string, { agent: Address; handle: string; tokens: bigint; usd: bigint; txs: number; last: bigint }>();
  for (const e of events) {
    const k = lc(e.agent);
    const row = by.get(k) ?? { agent: e.agent, handle: e.handle, tokens: 0n, usd: 0n, txs: 0, last: 0n };
    row.tokens += e.tokens;
    row.usd += e.usd;
    row.txs += 1;
    if (e.block > row.last) row.last = e.block;
    by.set(k, row);
  }
  return [...by.values()].sort((a, b) => (b.tokens > a.tokens ? 1 : b.tokens < a.tokens ? -1 : 0)).slice(0, limit);
}
