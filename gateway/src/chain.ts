import { createPublicClient, http, parseAbi, type Address } from "viem";
import { bsc, bscTestnet, foundry } from "viem/chains";
import { env } from "./config";

export const chain =
  env.CHAIN_ID === 56 ? bsc : env.CHAIN_ID === 97 ? bscTestnet : { ...foundry, id: env.CHAIN_ID, rpcUrls: { default: { http: [env.RPC_URL] } } };

export const client = createPublicClient({ chain, transport: http(env.RPC_URL) });
/** log scans go to an endpoint that serves eth_getLogs */
export const logsClient = createPublicClient({ chain, transport: http(env.LOGS_RPC_URL ?? env.RPC_URL) });

export const MINTER = env.MINTER_ADDRESS as Address;
export const TOKEN = env.TOKEN_ADDRESS as Address;
export const RAFFLE = env.RAFFLE_ADDRESS as Address;
export const VAULT = env.VAULT_ADDRESS as Address;
export const AGENT_IDS = env.AGENT_ID_REGISTRY_ADDRESS as Address;

export const minterAbi = parseAbi([
  "function mine() payable returns (uint256)",
  "function quote(uint256 weiAmount) view returns (uint256 total, uint256 toAgent)",
  "function usdOf(uint256 weiAmount) view returns (uint256)",
  "function bnbUsd() view returns (uint256)",
  "function totalMinted() view returns (uint256)",
  "function totalUsdPaid() view returns (uint256)",
  "function totalWeiPaid() view returns (uint256)",
  "function agentCount() view returns (uint256)",
  "function currentEpoch() view returns (uint256)",
  "function tokensPerUsd() view returns (uint256)",
  "function costToCap() view returns (uint256)",
  "function maxPerAgentPerEpoch() view returns (uint256)",
  "function minPaymentUsd() view returns (uint256)",
  "function minedBy(address) view returns (uint256)",
  "function remainingThisEpoch(address) view returns (uint256)",
  "function paused() view returns (bool)",
  "event Mined(address indexed agent, string handle, uint256 usdAmount18, uint256 tokensMinted, uint256 toAgent, uint256 epochAfter, uint256 weiPaid)",
]);

export const tokenAbi = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function pair() view returns (address)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export const raffleAbi = parseAbi([
  "function sync()",
  "function commit(uint256 i, uint256 snapshotBlock, bytes32 root, uint256 totalTickets) returns (uint256)",
  "function settle(uint256 id, address winner, uint256 start, uint256 count, bytes32[] proof)",
  "function retry(uint256 id)",
  "function pots(uint256) view returns (uint256 balance, uint256 threshold, uint16 shareBps, uint64 fullAtBlock, uint32 opened, uint64 activeDraw)",
  "function draws(uint256) view returns (uint8 pot, uint8 status, uint64 snapshotBlock, uint64 committedAt, uint256 totalTickets, uint256 prize, uint256 requestId, uint256 random, bytes32 root, address winner)",
  "function pending() view returns (uint256)",
  "function paidOut() view returns (uint256)",
  "function drawCount() view returns (uint256)",
  "function keeper() view returns (address)",
  "function coordinator() view returns (address)",
  "event Synced(uint256 inflow, uint256 toJade, uint256 toCinnabar, uint256 toGold)",
  "event PotFull(uint256 indexed pot, uint256 snapshotBlock)",
  "event DrawCommitted(uint256 indexed id, uint256 indexed pot, uint256 snapshotBlock, bytes32 root, uint256 totalTickets, uint256 prize, uint256 requestId)",
  "event DrawVoid(uint256 indexed id, uint256 indexed pot, uint256 snapshotBlock)",
  "event DrawRandom(uint256 indexed id, uint256 requestId, uint256 random, uint256 winningTicket)",
  "event DrawRetried(uint256 indexed id, uint256 requestId)",
  "event DrawSettled(uint256 indexed id, uint256 indexed pot, address indexed winner, uint256 prize, uint256 winningTicket)",
]);

export const mockVrfAbi = parseAbi(["function fulfill(uint256 id, uint256 word)"]);

export const agentIdAbi = parseAbi([
  "function handleOf(address wallet) view returns (string)",
  "function ownerOfHandle(string handle) view returns (address)",
]);

// ---------------------------------------------------------------- bounded cache

const MAX_CACHE = 5_000;
const cache = new Map<string, { at: number; v: unknown }>();
export async function memo<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
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
  return memo(`handle:${lc(wallet)}`, 10 * 60_000, async () =>
    (await client.readContract({ address: AGENT_IDS, abi: agentIdAbi, functionName: "handleOf", args: [wallet] })) as string,
  );
}

/** wallet holding `handle` (accepts "nemo" or "nemo.ai"), null if unregistered */
export async function walletOfHandle(handle: string): Promise<Address | null> {
  const h = handle.toLowerCase().replace(/\.ai$/, "");
  if (!/^[a-z0-9-]{1,64}$/.test(h)) return null;
  const a = await memo(`owner:${h}`, 60_000, async () =>
    (await client.readContract({ address: AGENT_IDS, abi: agentIdAbi, functionName: "ownerOfHandle", args: [h] })) as Address,
  );
  return a && !/^0x0{40}$/i.test(a) ? a : null;
}

export async function pairAddress(): Promise<Address> {
  return memo("pair", 24 * 3600_000, async () => (await client.readContract({ address: TOKEN, abi: tokenAbi, functionName: "pair" })) as Address);
}

const POT_KEYS = ["jade", "cin", "gold"] as const;

export async function stats() {
  return memo("stats", 8_000, async () => {
    const m = { address: MINTER, abi: minterAbi } as const;
    const [totalMinted, totalUsdPaid, totalWeiPaid, agentCount, currentEpoch, tokensPerUsd, costToCap, bnbUsd, maxPerAgentPerEpoch, minPaymentUsd, paused, totalSupply, vaultBalance] =
      await Promise.all([
        client.readContract({ ...m, functionName: "totalMinted" }),
        client.readContract({ ...m, functionName: "totalUsdPaid" }),
        client.readContract({ ...m, functionName: "totalWeiPaid" }),
        client.readContract({ ...m, functionName: "agentCount" }),
        client.readContract({ ...m, functionName: "currentEpoch" }),
        client.readContract({ ...m, functionName: "tokensPerUsd" }),
        client.readContract({ ...m, functionName: "costToCap" }),
        client.readContract({ ...m, functionName: "bnbUsd" }).catch(() => 0n),
        client.readContract({ ...m, functionName: "maxPerAgentPerEpoch" }),
        client.readContract({ ...m, functionName: "minPaymentUsd" }),
        client.readContract({ ...m, functionName: "paused" }),
        client.readContract({ address: TOKEN, abi: tokenAbi, functionName: "totalSupply" }),
        client.readContract({ address: TOKEN, abi: tokenAbi, functionName: "balanceOf", args: [VAULT] }),
      ]);
    return { chainId: env.CHAIN_ID, totalMinted, totalUsdPaid, totalWeiPaid, agentCount, currentEpoch, tokensPerUsd, costToCap, bnbUsd, maxPerAgentPerEpoch, minPaymentUsd, paused, totalSupply, cap: 1_000_000_000n * 10n ** 18n, vaultBalance };
  });
}

export async function pots() {
  return memo("pots", 3_000, async () => {
    const r = { address: RAFFLE, abi: raffleAbi } as const;
    const [p0, p1, p2, pending, paidOut] = await Promise.all([
      client.readContract({ ...r, functionName: "pots", args: [0n] }),
      client.readContract({ ...r, functionName: "pots", args: [1n] }),
      client.readContract({ ...r, functionName: "pots", args: [2n] }),
      client.readContract({ ...r, functionName: "pending" }),
      client.readContract({ ...r, functionName: "paidOut" }),
    ]);
    // YAN not yet synced is shown in the pots it will land in: 40% / 20% / the rest
    const a = (pending * 4000n) / 10_000n, b = (pending * 2000n) / 10_000n;
    const adds = [a, b, pending - a - b];
    return {
      pending,
      paidOut,
      pots: [p0, p1, p2].map(([balance, threshold, , fullAtBlock, opened, activeDraw], i) => ({
        index: i,
        key: POT_KEYS[i],
        balance: balance + adds[i],
        threshold,
        opened: Number(opened),
        fullAtBlock: Number(fullAtBlock),
        activeDraw: Number(activeDraw),
      })),
    };
  });
}

export async function quote(wei: bigint) {
  const [[total, toAgent], usd] = await Promise.all([
    client.readContract({ address: MINTER, abi: minterAbi, functionName: "quote", args: [wei] }),
    client.readContract({ address: MINTER, abi: minterAbi, functionName: "usdOf", args: [wei] }),
  ]);
  const toVault = (total * 2500n) / 10_000n;
  return { total, toAgent, toVault, toRaffle: total - toAgent - toVault, usd };
}

export async function agentReads(wallet: Address) {
  const m = { address: MINTER, abi: minterAbi } as const;
  const [minedBy, remaining, balance] = await Promise.all([
    client.readContract({ ...m, functionName: "minedBy", args: [wallet] }),
    client.readContract({ ...m, functionName: "remainingThisEpoch", args: [wallet] }),
    client.readContract({ address: TOKEN, abi: tokenAbi, functionName: "balanceOf", args: [wallet] }),
  ]);
  return { minedBy, remaining, balance };
}
