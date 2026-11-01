import { createPublicClient, http, parseAbi, parseAbiItem, type Address } from "viem";
import { bsc, bscTestnet, foundry } from "viem/chains";
import { env } from "./config";
import PoiAbi from "./abi/ProofOfInference.json";
import StakeAbi from "./abi/SuanStake.json";
import TokenAbi from "./abi/SuanToken.json";

export const chain =
  env.CHAIN_ID === 56 ? bsc : env.CHAIN_ID === 97 ? bscTestnet : { ...foundry, id: env.CHAIN_ID, rpcUrls: { default: { http: [env.RPC_URL] } } };

export const client = createPublicClient({ chain, transport: http(env.RPC_URL) });

export const POI = env.POI_ADDRESS as Address;
export const TOKEN = env.TOKEN_ADDRESS as Address;
export const STAKE = env.STAKE_ADDRESS as Address;
export const STABLE = env.STABLE_ADDRESS as Address;
export const REGISTRY = env.REGISTRY_ADDRESS as Address;

export const poiAbi = PoiAbi as any;
export const stakeAbi = StakeAbi as any;
export const tokenAbi = TokenAbi as any;

export const registryAbi = parseAbi([
  "function ownerOf(uint256 agentId) view returns (address)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenURI(uint256 agentId) view returns (string)",
  "function register(string agentURI) returns (uint256)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
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

export async function isOperator(agentId: bigint, who: Address): Promise<boolean> {
  try {
    return await memo(`op:${agentId}:${who.toLowerCase()}`, 10_000, async () =>
      (await client.readContract({ address: POI, abi: poiAbi, functionName: "isOperator", args: [agentId, who] })) as boolean,
    );
  } catch {
    return false; // nonexistent agent reverts in ownerOf; RPC failure is not cached
  }
}

export async function creditsUsd(agentId: bigint): Promise<bigint> {
  return memo(`credits:${agentId}`, 5_000, async () =>
    (await client.readContract({ address: POI, abi: poiAbi, functionName: "creditsUsd", args: [agentId] })) as bigint,
  );
}

export async function stakedOf(agentId: bigint): Promise<bigint> {
  return memo(`staked:${agentId}`, 30_000, async () =>
    (await client.readContract({ address: STAKE, abi: stakeAbi, functionName: "staked", args: [agentId] })) as bigint,
  );
}

/** true if the agent has ever mined or redeemed (cheap existence check for public endpoints) */
export async function agentSeen(agentId: bigint): Promise<boolean> {
  return memo(`seen:${agentId}`, 30_000, async () =>
    (await client.readContract({ address: POI, abi: poiAbi, functionName: "seen", args: [agentId] })) as boolean,
  );
}

export interface ProtocolStats {
  chainId: number;
  totalMinted: bigint;
  totalUsdPaid: bigint;
  totalRedeemed: bigint;
  agentCount: bigint;
  currentEpoch: bigint;
  tokensPerUsd: bigint;
  costToCap: bigint;
  totalSupply: bigint;
  totalStaked: bigint;
  cap: bigint;
}

export async function stats(): Promise<ProtocolStats> {
  return memo("stats", 10_000, async () => {
    const poi = { address: POI, abi: poiAbi } as const;
    const rd = (c: { address: Address; abi: any; functionName: string }) =>
      client.readContract({ address: c.address, abi: c.abi, functionName: c.functionName }) as Promise<bigint>;
    const [totalMinted, totalUsdPaid, totalRedeemed, agentCount, currentEpoch, tokensPerUsd, costToCap, totalSupply, totalStaked, cap] =
      await Promise.all([
        rd({ ...poi, functionName: "totalMinted" }),
        rd({ ...poi, functionName: "totalUsdPaid" }),
        rd({ ...poi, functionName: "totalRedeemed" }),
        rd({ ...poi, functionName: "agentCount" }),
        rd({ ...poi, functionName: "currentEpoch" }),
        rd({ ...poi, functionName: "tokensPerUsd" }),
        rd({ ...poi, functionName: "costToCap" }),
        rd({ address: TOKEN, abi: tokenAbi, functionName: "totalSupply" }),
        rd({ address: STAKE, abi: stakeAbi, functionName: "totalStaked" }),
        rd({ address: TOKEN, abi: tokenAbi, functionName: "CAP" }),
      ]);
    return { chainId: env.CHAIN_ID, totalMinted, totalUsdPaid, totalRedeemed, agentCount, currentEpoch, tokensPerUsd, costToCap, totalSupply, totalStaked, cap };
  });
}

export interface MinedEvent {
  agentId: bigint;
  miner: Address;
  usd: bigint;
  tokens: bigint;
  epochAfter: bigint;
  block: bigint;
  tx: `0x${string}`;
}

const minedAbi = parseAbiItem(
  "event Mined(uint256 indexed agentId, address indexed miner, uint256 usdAmount18, uint256 tokensMinted, uint256 epochAfter)",
);

/// Mined events since DEPLOY_BLOCK, cached and extended incrementally. Single in-flight scan.
let minedCache: { upTo: bigint; events: MinedEvent[] } = { upTo: env.DEPLOY_BLOCK > 0n ? env.DEPLOY_BLOCK - 1n : 0n, events: [] };
let scanning: Promise<MinedEvent[]> | null = null;

export function minedEvents(): Promise<MinedEvent[]> {
  if (scanning) return scanning;
  scanning = (async () => {
    try {
      const head = await client.getBlockNumber();
      if (head <= minedCache.upTo) return minedCache.events;
      const step = 5_000n; // public RPC log window
      const fresh: MinedEvent[] = [];
      for (let from = minedCache.upTo + 1n; from <= head; from += step + 1n) {
        const to = from + step > head ? head : from + step;
        const logs = await client.getLogs({ address: POI, event: minedAbi, fromBlock: from, toBlock: to });
        for (const l of logs) {
          const a = l.args;
          fresh.push({ agentId: a.agentId!, miner: a.miner!, usd: a.usdAmount18!, tokens: a.tokensMinted!, epochAfter: a.epochAfter!, block: l.blockNumber!, tx: l.transactionHash! });
        }
      }
      minedCache = { upTo: head, events: [...minedCache.events, ...fresh] };
      return minedCache.events;
    } finally {
      scanning = null;
    }
  })();
  return scanning;
}

export function leaderboard(events: MinedEvent[], limit = 50) {
  const byAgent = new Map<string, { agentId: bigint; tokens: bigint; usd: bigint; txs: number; last: bigint }>();
  for (const e of events) {
    const k = e.agentId.toString();
    const row = byAgent.get(k) ?? { agentId: e.agentId, tokens: 0n, usd: 0n, txs: 0, last: 0n };
    row.tokens += e.tokens;
    row.usd += e.usd;
    row.txs += 1;
    if (e.block > row.last) row.last = e.block;
    byAgent.set(k, row);
  }
  return [...byAgent.values()].sort((a, b) => (b.tokens > a.tokens ? 1 : b.tokens < a.tokens ? -1 : 0)).slice(0, limit);
}
