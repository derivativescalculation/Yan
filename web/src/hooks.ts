import { useQuery } from "@tanstack/react-query";
import { useReadContracts, usePublicClient, useBalance } from "wagmi";
import { parseAbiItem } from "viem";
import { deployment, poiAbi, tokenAbi, stakeAbi, burnerAbi, GATEWAY } from "./chain";

export function useProtocol() {
  const d = deployment!;
  const poi = { address: d.proofOfInference, abi: poiAbi } as const;
  const q = useReadContracts({
    contracts: [
      { ...poi, functionName: "totalMinted" },
      { ...poi, functionName: "totalUsdPaid" },
      { ...poi, functionName: "totalRedeemed" },
      { ...poi, functionName: "agentCount" },
      { ...poi, functionName: "currentEpoch" },
      { ...poi, functionName: "tokensPerUsd" },
      { ...poi, functionName: "initialTokensPerUsd" },
      { ...poi, functionName: "decayBps" },
      { ...poi, functionName: "costToCap" },
      { ...poi, functionName: "burnBps" },
      { ...poi, functionName: "redeemBps" },
      { address: d.token, abi: tokenAbi, functionName: "totalSupply" },
      { address: d.stake, abi: stakeAbi, functionName: "totalStaked" },
      { address: d.burner, abi: burnerAbi, functionName: "totalBurned" },
      { address: d.burner, abi: burnerAbi, functionName: "totalWeiSpent" },
      { ...poi, functionName: "bnbUsd" },
      { ...poi, functionName: "totalWeiPaid" },
      { ...poi, functionName: "maxPerAgentPerEpoch" },
      { ...poi, functionName: "minPaymentUsd" },
    ],
    query: { refetchInterval: 12_000 },
  });
  const r = (i: number) => q.data?.[i]?.result as any;
  const ops = useBalance({ address: d.opsTreasury, query: { refetchInterval: 15_000 } });
  const burnerBal = useBalance({ address: d.burner, query: { refetchInterval: 15_000 } });
  return {
    loading: q.isLoading,
    totalMinted: r(0) as bigint | undefined,
    totalUsdPaid: r(1) as bigint | undefined,
    totalRedeemed: r(2) as bigint | undefined,
    agentCount: r(3) as bigint | undefined,
    currentEpoch: r(4) as bigint | undefined,
    tokensPerUsd: r(5) as bigint | undefined,
    initialTokensPerUsd: r(6) as bigint | undefined,
    decayBps: r(7) as bigint | undefined,
    costToCap: r(8) as bigint | undefined,
    burnBps: r(9) as bigint | undefined,
    redeemBps: r(10) as bigint | undefined,
    totalSupply: r(11) as bigint | undefined,
    totalStaked: r(12) as bigint | undefined,
    burnedByBuyback: r(13) as bigint | undefined,
    weiSpent: r(14) as bigint | undefined,
    bnbUsd: r(15) as bigint | undefined,
    totalWeiPaid: r(16) as bigint | undefined,
    maxPerAgentPerEpoch: r(17) as bigint | undefined,
    minPaymentUsd: r(18) as bigint | undefined,
    opsBalance: ops.data?.value,
    burnerBalance: burnerBal.data?.value,
  };
}

export const minedEvent = parseAbiItem(
  "event Mined(address indexed agent, string handle, uint256 usdAmount18, uint256 tokensMinted, uint256 epochAfter, uint256 weiPaid)",
);
export const burnedEvent = parseAbiItem("event Burned(uint256 weiIn, uint256 tokensBurned)");

export interface Mined {
  agent: `0x${string}`;
  handle: string;
  usd: bigint;
  tokens: bigint;
  wei: bigint;
  block: bigint;
  tx: `0x${string}`;
}

export interface LeaderRow {
  agent: `0x${string}`;
  handle: string;
  tokens: bigint;
  usd: bigint;
  txs: number;
}

/** eth_getLogs over [from, head] in adaptive windows (providers cap the range). */
async function scanLogs<T>(from: bigint, head: bigint, fetchWindow: (a: bigint, b: bigint) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  let step = 5_000n;
  let f = from;
  while (f <= head) {
    const to = f + step - 1n > head ? head : f + step - 1n;
    try {
      out.push(...(await fetchWindow(f, to)));
      f = to + 1n;
      if (step < 5_000n) step *= 2n;
    } catch (e) {
      if (step <= 250n) throw e;
      step /= 2n;
    }
  }
  return out;
}

/** Direct chain read of Mined logs over a recent window (fallback when the gateway is down). */
export function useMinedLogs(window = 40_000n, enabled = true) {
  const pc = usePublicClient();
  const d = deployment!;
  return useQuery({
    queryKey: ["mined", d.proofOfInference],
    enabled: !!pc && enabled,
    refetchInterval: 15_000,
    queryFn: async (): Promise<Mined[]> => {
      const head = await pc!.getBlockNumber();
      const from = head > window ? head - window : 0n;
      return scanLogs<Mined>(from, head, async (f, to) => {
        const logs = await pc!.getLogs({ address: d.proofOfInference, event: minedEvent, fromBlock: f, toBlock: to });
        return logs.map((l) => ({
          agent: l.args.agent!,
          handle: l.args.handle!,
          usd: l.args.usdAmount18!,
          tokens: l.args.tokensMinted!,
          wei: l.args.weiPaid!,
          block: l.blockNumber!,
          tx: l.transactionHash!,
        }));
      });
    },
  });
}

export function useBurnLogs(window = 40_000n) {
  const pc = usePublicClient();
  const d = deployment!;
  return useQuery({
    queryKey: ["burned", d.burner],
    enabled: !!pc,
    refetchInterval: 30_000,
    queryFn: async () => {
      const head = await pc!.getBlockNumber();
      const from = head > window ? head - window : 0n;
      return scanLogs(from, head, async (f, to) => {
        const logs = await pc!.getLogs({ address: d.burner, event: burnedEvent, fromBlock: f, toBlock: to });
        return logs.map((l) => ({ weiIn: l.args.weiIn!, tokens: l.args.tokensBurned!, block: l.blockNumber!, tx: l.transactionHash! }));
      });
    },
  });
}

export function leaderboard(events: Mined[]): LeaderRow[] {
  const m = new Map<string, LeaderRow>();
  for (const e of events) {
    const k = e.agent.toLowerCase();
    const r = m.get(k) ?? { agent: e.agent, handle: e.handle, tokens: 0n, usd: 0n, txs: 0 };
    r.tokens += e.tokens;
    r.usd += e.usd;
    r.txs += 1;
    m.set(k, r);
  }
  return [...m.values()].sort((a, b) => (b.tokens > a.tokens ? 1 : b.tokens < a.tokens ? -1 : 0));
}

/**
 * Leaderboard + recent mints. Uses the gateway's full history since the deploy block; if the gateway
 * is unreachable, falls back to on-chain logs over a recent block window.
 * `agent` may be a wallet address or a .ai name.
 */
export function useMining(agent?: string) {
  const chainLogs = useMinedLogs(40_000n, !GATEWAY);
  const q = useQuery({
    queryKey: ["mining", GATEWAY, agent ?? "all"],
    enabled: !!GATEWAY,
    retry: 1,
    refetchInterval: 15_000,
    queryFn: async () => {
      const r = await fetch(`${GATEWAY}/v1/leaderboard${agent ? `?agent=${encodeURIComponent(agent)}` : ""}`);
      if (!r.ok) throw new Error(String(r.status));
      const j = (await r.json()) as { agents: any[]; recent: any[] };
      const rows: LeaderRow[] = j.agents.map((a) => ({ agent: a.agent, handle: a.handle, tokens: BigInt(a.tokens), usd: BigInt(a.usd), txs: Number(a.txs) }));
      const feed: Mined[] = j.recent.map((e) => ({
        agent: e.agent,
        handle: e.handle,
        usd: BigInt(e.usd),
        tokens: BigInt(e.tokens),
        wei: BigInt(e.weiPaid ?? 0),
        block: BigInt(e.block),
        tx: e.tx,
      }));
      return { rows, feed };
    },
  });
  const fallback = useMinedLogs(40_000n, !!GATEWAY && q.isError);
  if (q.data) return { rows: q.data.rows, feed: q.data.feed, loading: false };
  const src = GATEWAY ? fallback : chainLogs;
  const a = agent?.toLowerCase().replace(/\.ai$/, "");
  const events = (src.data ?? []).filter((e) => !a || e.agent.toLowerCase() === a || e.handle === a);
  return { rows: leaderboard(events), feed: [...events].reverse().slice(0, 60), loading: q.isLoading || src.isLoading };
}

async function gw<T>(path: string): Promise<T> {
  if (!GATEWAY) throw new Error("no gateway");
  const r = await fetch(`${GATEWAY}${path}`);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

export interface GatewayAgent {
  wallet: `0x${string}`;
  handle: string | null;
  isAgent: boolean;
  minedBy: string;
  remainingThisEpoch: string | null;
  creditUsd18: string;
  usedUsd18: string;
  balanceUsd18: string;
  staked: string;
  tier: string;
  discountBps: number;
  rpm: number;
  recent: { model: string; inputTokens: number; outputTokens: number; costUsd18: string; createdAt: number }[];
}

/** id: .ai name ("nemo" or "nemo.ai") or wallet address */
export function useGatewayAgent(id?: string) {
  return useQuery({
    queryKey: ["gw-agent", id],
    enabled: !!id && !!GATEWAY,
    retry: 0,
    queryFn: () => gw<GatewayAgent>(`/v1/agents/${encodeURIComponent(id!)}`),
  });
}

export interface QuoteResult {
  usd: string;
  tokens: string;
  meetsMinimum: boolean;
  agent?: { wallet: string; handle: string | null; remainingThisEpoch: string | null } | null;
  canMine?: boolean;
  reason?: string | null;
}

export function useQuote(bnb: string, agent?: string) {
  return useQuery({
    queryKey: ["quote", bnb, agent ?? ""],
    enabled: !!GATEWAY && /^\d*\.?\d+$/.test(bnb) && Number(bnb) > 0,
    retry: 0,
    refetchInterval: 15_000,
    queryFn: () => gw<QuoteResult>(`/v1/quote?bnb=${encodeURIComponent(bnb)}${agent ? `&agent=${encodeURIComponent(agent)}` : ""}`),
  });
}
