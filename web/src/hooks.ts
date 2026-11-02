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
    opsBalance: ops.data?.value,
    burnerBalance: burnerBal.data?.value,
  };
}

export const minedEvent = parseAbiItem(
  "event Mined(uint256 indexed agentId, address indexed miner, uint256 usdAmount18, uint256 tokensMinted, uint256 epochAfter, uint256 weiPaid)",
);
export const burnedEvent = parseAbiItem("event Burned(uint256 weiIn, uint256 tokensBurned)");


/** eth_getLogs over [from, head] in adaptive windows (providers cap the range). */
async function scanLogs<T>(pc: any, from: bigint, head: bigint, fetchWindow: (a: bigint, b: bigint) => Promise<T[]>): Promise<T[]> {
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

export interface Mined {
  agentId: bigint;
  miner: `0x${string}`;
  usd: bigint;
  tokens: bigint;
  wei: bigint;
  block: bigint;
  tx: `0x${string}`;
}

export interface LeaderRow {
  agentId: bigint;
  tokens: bigint;
  usd: bigint;
  txs: number;
}

/**
 * Leaderboard + recent mints. Uses the gateway's full history since the deploy block; if the gateway
 * is unreachable, falls back to on-chain logs over a recent block window (marked partial).
 */
export function useMining(agentId?: bigint) {
  const chainLogs = useMinedLogs(40_000n, !GATEWAY);
  const q = useQuery({
    queryKey: ["mining", GATEWAY, agentId?.toString() ?? "all"],
    enabled: !!GATEWAY,
    retry: 1,
    refetchInterval: 15_000,
    queryFn: async () => {
      const url = `${GATEWAY}/v1/leaderboard${agentId !== undefined ? `?agent=${agentId}` : ""}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(String(r.status));
      const j = (await r.json()) as { agents: any[]; recent: any[] };
      const rows: LeaderRow[] = j.agents.map((a) => ({ agentId: BigInt(a.agentId), tokens: BigInt(a.tokens), usd: BigInt(a.usd), txs: Number(a.txs) }));
      const feed: Mined[] = j.recent.map((e) => ({
        agentId: BigInt(e.agentId),
        miner: e.miner,
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
  if (q.data) return { rows: q.data.rows, feed: q.data.feed, loading: false, partial: false };
  const src = GATEWAY ? fallback : chainLogs;
  const events = (src.data ?? []).filter((e) => agentId === undefined || e.agentId === agentId);
  return {
    rows: leaderboard(events),
    feed: [...events].reverse().slice(0, 60),
    loading: q.isLoading || src.isLoading,
    partial: true,
  };
}

/** Direct chain read of Mined logs over a recent block window (fallback when the gateway is down). */
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
      return scanLogs<Mined>(pc, from, head, async (f, to) => {
        const out: Mined[] = [];
        const logs = await pc!.getLogs({ address: d.proofOfInference, event: minedEvent, fromBlock: f, toBlock: to });
        for (const l of logs)
          out.push({
            agentId: l.args.agentId!,
            miner: l.args.miner!,
            usd: l.args.usdAmount18!,
            tokens: l.args.tokensMinted!,
            wei: l.args.weiPaid!,
            block: l.blockNumber!,
            tx: l.transactionHash!,
          });
        return out;
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
      return scanLogs(pc, from, head, async (f, to) => {
        const logs = await pc!.getLogs({ address: d.burner, event: burnedEvent, fromBlock: f, toBlock: to });
        return logs.map((l) => ({ weiIn: l.args.weiIn!, tokens: l.args.tokensBurned!, block: l.blockNumber!, tx: l.transactionHash! }));
      });
    },
  });
}

export function leaderboard(events: Mined[]) {
  const m = new Map<string, { agentId: bigint; tokens: bigint; usd: bigint; txs: number; last: bigint }>();
  for (const e of events) {
    const k = e.agentId.toString();
    const r = m.get(k) ?? { agentId: e.agentId, tokens: 0n, usd: 0n, txs: 0, last: 0n };
    r.tokens += e.tokens;
    r.usd += e.usd;
    r.txs += 1;
    if (e.block > r.last) r.last = e.block;
    m.set(k, r);
  }
  return [...m.values()].sort((a, b) => (b.tokens > a.tokens ? 1 : b.tokens < a.tokens ? -1 : 0));
}

async function gw<T>(path: string): Promise<T> {
  if (!GATEWAY) throw new Error("no gateway");
  const r = await fetch(`${GATEWAY}${path}`);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

export function useGatewayAgent(id?: string) {
  return useQuery({
    queryKey: ["gw-agent", id],
    enabled: !!id && !!GATEWAY,
    retry: 0,
    queryFn: () =>
      gw<{
        creditUsd18: string;
        usedUsd18: string;
        balanceUsd18: string;
        tier: string;
        discountBps: number;
        rpm: number;
        recent: { model: string; inputTokens: number; outputTokens: number; costUsd18: string; createdAt: number }[];
      }>(`/v1/agents/${id}`),
  });
}

export function useGatewayStats() {
  return useQuery({
    queryKey: ["gw-stats"],
    enabled: !!GATEWAY,
    retry: 0,
    queryFn: () => gw<{ gateway: { requests: number; usedUsd18: string; outputTokens: number } }>("/v1/stats"),
  });
}
