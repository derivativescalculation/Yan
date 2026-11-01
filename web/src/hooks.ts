import { useQuery } from "@tanstack/react-query";
import { useReadContracts, usePublicClient } from "wagmi";
import { parseAbiItem } from "viem";
import { deployment, poiAbi, tokenAbi, stakeAbi, burnerAbi, erc20Abi, GATEWAY } from "./chain";

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
      { address: d.burner, abi: burnerAbi, functionName: "totalStableSpent" },
      { address: d.stable, abi: erc20Abi, functionName: "balanceOf", args: [d.opsTreasury] },
      { address: d.stable, abi: erc20Abi, functionName: "balanceOf", args: [d.burner] },
      { address: d.stable, abi: erc20Abi, functionName: "decimals" },
      { address: d.stable, abi: erc20Abi, functionName: "symbol" },
    ],
    query: { refetchInterval: 12_000 },
  });
  const r = (i: number) => q.data?.[i]?.result as any;
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
    stableSpent: r(14) as bigint | undefined,
    opsBalance: r(15) as bigint | undefined,
    burnerBalance: r(16) as bigint | undefined,
    stableDecimals: (r(17) as number | undefined) ?? 18,
    stableSymbol: (r(18) as string | undefined) ?? "USD",
  };
}

export const minedEvent = parseAbiItem(
  "event Mined(uint256 indexed agentId, address indexed miner, uint256 usdAmount18, uint256 tokensMinted, uint256 epochAfter)",
);
export const burnedEvent = parseAbiItem("event Burned(uint256 stableIn, uint256 tokensBurned)");

export interface Mined {
  agentId: bigint;
  miner: `0x${string}`;
  usd: bigint;
  tokens: bigint;
  block: bigint;
  tx: `0x${string}`;
}

/** Direct chain read of Mined logs (works without the gateway). */
export function useMinedLogs(window = 40_000n) {
  const pc = usePublicClient();
  const d = deployment!;
  return useQuery({
    queryKey: ["mined", d.proofOfInference],
    enabled: !!pc,
    refetchInterval: 15_000,
    queryFn: async (): Promise<Mined[]> => {
      const head = await pc!.getBlockNumber();
      const from = head > window ? head - window : 0n;
      const step = 5_000n;
      const out: Mined[] = [];
      for (let f = from; f <= head; f += step + 1n) {
        const to = f + step > head ? head : f + step;
        const logs = await pc!.getLogs({ address: d.proofOfInference, event: minedEvent, fromBlock: f, toBlock: to });
        for (const l of logs)
          out.push({
            agentId: l.args.agentId!,
            miner: l.args.miner!,
            usd: l.args.usdAmount18!,
            tokens: l.args.tokensMinted!,
            block: l.blockNumber!,
            tx: l.transactionHash!,
          });
      }
      return out;
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
      const logs = await pc!.getLogs({ address: d.burner, event: burnedEvent, fromBlock: from, toBlock: head });
      return logs.map((l) => ({ stableIn: l.args.stableIn!, tokens: l.args.tokensBurned!, block: l.blockNumber!, tx: l.transactionHash! }));
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
