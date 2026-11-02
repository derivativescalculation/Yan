import { useQuery } from "@tanstack/react-query";
import { useReadContracts, usePublicClient, useBalance } from "wagmi";
import { parseAbiItem } from "viem";
import { deployment, minterAbi, tokenAbi, raffleAbi, GATEWAY } from "./chain";

export function useProtocol() {
  const d = deployment!;
  const m = { address: d.minter, abi: minterAbi } as const;
  const q = useReadContracts({
    contracts: [
      { ...m, functionName: "totalMinted" },
      { ...m, functionName: "totalUsdPaid" },
      { ...m, functionName: "agentCount" },
      { ...m, functionName: "currentEpoch" },
      { ...m, functionName: "tokensPerUsd" },
      { ...m, functionName: "initialTokensPerUsd" },
      { ...m, functionName: "decayBps" },
      { ...m, functionName: "costToCap" },
      { ...m, functionName: "bnbUsd" },
      { ...m, functionName: "totalWeiPaid" },
      { ...m, functionName: "maxPerAgentPerEpoch" },
      { ...m, functionName: "minPaymentUsd" },
      { address: d.token, abi: tokenAbi, functionName: "totalSupply" },
      { address: d.token, abi: tokenAbi, functionName: "balanceOf", args: [d.liquidityVault] },
      { address: d.token, abi: tokenAbi, functionName: "balanceOf", args: [d.raffle] },
      { address: d.raffle, abi: raffleAbi, functionName: "paidOut" },
    ],
    query: { refetchInterval: 12_000 },
  });
  const r = (i: number) => q.data?.[i]?.result as any;
  const treasury = useBalance({ address: d.treasury, query: { refetchInterval: 15_000 } });
  return {
    loading: q.isLoading,
    totalMinted: r(0) as bigint | undefined,
    totalUsdPaid: r(1) as bigint | undefined,
    agentCount: r(2) as bigint | undefined,
    currentEpoch: r(3) as bigint | undefined,
    tokensPerUsd: r(4) as bigint | undefined,
    initialTokensPerUsd: r(5) as bigint | undefined,
    decayBps: r(6) as bigint | undefined,
    costToCap: r(7) as bigint | undefined,
    bnbUsd: r(8) as bigint | undefined,
    totalWeiPaid: r(9) as bigint | undefined,
    maxPerAgentPerEpoch: r(10) as bigint | undefined,
    minPaymentUsd: r(11) as bigint | undefined,
    totalSupply: r(12) as bigint | undefined,
    vaultBalance: r(13) as bigint | undefined,
    raffleBalance: r(14) as bigint | undefined,
    rafflePaidOut: r(15) as bigint | undefined,
    treasuryBalance: treasury.data?.value,
  };
}

export const minedEvent = parseAbiItem(
  "event Mined(address indexed agent, string handle, uint256 usdAmount18, uint256 tokensMinted, uint256 toAgent, uint256 epochAfter, uint256 weiPaid)",
);

export interface Mined {
  agent: `0x${string}`;
  handle: string;
  usd: bigint;
  total: bigint;
  toAgent: bigint;
  wei: bigint;
  block: bigint;
  tx: `0x${string}`;
}

export interface LeaderRow {
  agent: `0x${string}`;
  handle: string;
  toAgent: bigint;
  total: bigint;
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
    queryKey: ["mined", d.minter],
    enabled: !!pc && enabled,
    refetchInterval: 15_000,
    queryFn: async (): Promise<Mined[]> => {
      const head = await pc!.getBlockNumber();
      const from = head > window ? head - window : 0n;
      return scanLogs<Mined>(from, head, async (f, to) => {
        const logs = await pc!.getLogs({ address: d.minter, event: minedEvent, fromBlock: f, toBlock: to });
        return logs.map((l) => ({
          agent: l.args.agent!,
          handle: l.args.handle!,
          usd: l.args.usdAmount18!,
          total: l.args.tokensMinted!,
          toAgent: l.args.toAgent!,
          wei: l.args.weiPaid!,
          block: l.blockNumber!,
          tx: l.transactionHash!,
        }));
      });
    },
  });
}

export function leaderboard(events: Mined[]): LeaderRow[] {
  const m = new Map<string, LeaderRow>();
  for (const e of events) {
    const k = e.agent.toLowerCase();
    const r = m.get(k) ?? { agent: e.agent, handle: e.handle, toAgent: 0n, total: 0n, usd: 0n, txs: 0 };
    r.toAgent += e.toAgent;
    r.total += e.total;
    r.usd += e.usd;
    r.txs += 1;
    m.set(k, r);
  }
  return [...m.values()].sort((a, b) => (b.total > a.total ? 1 : b.total < a.total ? -1 : 0));
}

const toMined = (e: any): Mined => ({
  agent: e.agent,
  handle: e.handle,
  usd: BigInt(e.usd),
  total: BigInt(e.total),
  toAgent: BigInt(e.toAgent),
  wei: BigInt(e.weiPaid ?? 0),
  block: BigInt(e.block),
  tx: e.tx,
});

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
      const j = (await r.json()) as { rows: any[]; feed: any[] };
      const rows: LeaderRow[] = j.rows.map((a) => ({
        agent: a.agent, handle: a.handle, toAgent: BigInt(a.toAgent), total: BigInt(a.total), usd: BigInt(a.usd), txs: Number(a.txs),
      }));
      return { rows, feed: j.feed.map(toMined) };
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

export interface GatewayWin {
  id: number;
  pot: number;
  prize: string;
  winningTicket: string;
  totalTickets: string;
  settleTx: `0x${string}`;
  settleBlock: string;
}

export interface GatewayAgent {
  wallet: `0x${string}`;
  handle: string | null;
  isAgent: boolean;
  minedBy: string;
  remainingThisEpoch: string | null;
  balance: string;
  tickets: string;
  totalTickets: string;
  mints: any[];
  wins: GatewayWin[];
}

/** id: .ai name ("nemo" or "nemo.ai") or wallet address */
export function useGatewayAgent(id?: string) {
  return useQuery({
    queryKey: ["gw-agent", id],
    enabled: !!id && !!GATEWAY,
    retry: 0,
    refetchInterval: 15_000,
    queryFn: async () => {
      const a = await gw<GatewayAgent>(`/v1/agents/${encodeURIComponent(id!)}`);
      return { ...a, mints: a.mints.map(toMined) };
    },
  });
}

export interface QuoteResult {
  usd: string;
  total: string;
  toAgent: string;
  toVault: string;
  toRaffle: string;
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
    queryFn: async () => {
      const r = await fetch(`${GATEWAY}/v1/quote?bnb=${encodeURIComponent(bnb)}${agent ? `&agent=${encodeURIComponent(agent)}` : ""}`);
      if (r.status === 404) return { agentMissing: true } as QuoteResult & { agentMissing: true };
      if (!r.ok) throw new Error(String(r.status));
      return (await r.json()) as QuoteResult & { agentMissing?: false };
    },
  });
}
