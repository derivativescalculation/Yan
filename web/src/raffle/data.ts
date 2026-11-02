import { useQuery } from "@tanstack/react-query";
import { GATEWAY } from "../chain";

// Raffle reads from the gateway. All amounts are wei strings, 18 decimals.

export type PotKey = "jade" | "cin" | "gold";
export type DrawStatus = "committed" | "random" | "settled" | "void";

export interface RafflePot {
  index: number;
  key: PotKey;
  balance: string;
  threshold: string;
  opened: number;
  fullAtBlock: number;
  activeDraw: number;
}

export interface RaffleDraw {
  id: number;
  pot: number;
  status: DrawStatus;
  snapshotBlock: number;
  totalTickets: number;
  prize: string;
  random: string | null;
  winningTicket: number | null;
  winner: `0x${string}` | null;
  handle: string | null;
  winnerTickets: number | null;
  commitTx: string;
  settleTx: string | null;
  settledAt: number | null;
}

export interface RaffleState {
  raffle: string;
  token: string;
  ticketUnit: string;
  holders: number;
  totalTickets: number;
  ticketsAsOfBlock: number;
  pots: RafflePot[];
  paidOut: string;
  drawsSettled: number;
  /** newest first, up to 40 */
  draws: RaffleDraw[];
}

export interface FeedEvent {
  kind: "mint" | "sell";
  wallet: `0x${string}`;
  handle: string | null;
  amount: string;
  /** wei added to each pot, by pot index */
  adds: [string, string, string];
  block: number;
  tx: string;
}

export interface TicketInfo {
  wallet: `0x${string}`;
  handle: string | null;
  balance: string;
  minBalance: string;
  tickets: number;
  totalTickets: number;
}

/** A .ai name the registry doesn't know. */
export class NotFoundError extends Error {}

/** Dev only: `?fixture=1` serves a scripted fixture instead of the gateway (see fixture.ts). */
export const FIXTURE = import.meta.env.DEV && new URLSearchParams(location.search).get("fixture") === "1";
/** Whether there is anything to read from at all. */
export const LIVE = FIXTURE || !!GATEWAY;
const fixture = () => import("./fixture");

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${GATEWAY}${path}`);
  if (r.status === 404) {
    const j = await r.json().catch(() => null);
    throw new NotFoundError(j?.error ?? "not found");
  }
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

// The gateway may send counts and block numbers as strings; the page always gets numbers.
type Raw = Record<string, any>;
const list = (a: unknown): Raw[] => (Array.isArray(a) ? a : []);
const int = (v: unknown) => Number(v ?? 0) || 0;
const intOrNull = (v: unknown) => (v === null || v === undefined || v === "" ? null : int(v));
const wei = (v: unknown) => (v === null || v === undefined || v === "" ? "0" : String(v));

function toState(j: Raw): RaffleState {
  return {
    raffle: j.raffle,
    token: j.token,
    ticketUnit: wei(j.ticketUnit),
    holders: int(j.holders),
    totalTickets: int(j.totalTickets),
    ticketsAsOfBlock: int(j.ticketsAsOfBlock),
    paidOut: wei(j.paidOut),
    drawsSettled: int(j.drawsSettled),
    pots: list(j.pots).map((p, i) => ({
      index: p.index === undefined ? i : int(p.index),
      key: p.key,
      balance: wei(p.balance),
      threshold: wei(p.threshold),
      opened: int(p.opened),
      fullAtBlock: int(p.fullAtBlock),
      activeDraw: int(p.activeDraw),
    })),
    draws: list(j.draws).map((d) => ({
      id: int(d.id),
      pot: int(d.pot),
      status: d.status,
      snapshotBlock: int(d.snapshotBlock),
      totalTickets: int(d.totalTickets),
      prize: wei(d.prize),
      random: d.random ?? null,
      winningTicket: intOrNull(d.winningTicket),
      winner: d.winner ?? null,
      handle: d.handle ?? null,
      winnerTickets: intOrNull(d.winnerTickets),
      commitTx: d.commitTx,
      settleTx: d.settleTx ?? null,
      settledAt: intOrNull(d.settledAt),
    })),
  };
}

const toEvent = (e: Raw): FeedEvent => ({
  kind: e.kind,
  wallet: e.wallet,
  handle: e.handle ?? null,
  amount: wei(e.amount),
  adds: [0, 1, 2].map((i) => wei(e.adds?.[i])) as [string, string, string],
  block: int(e.block),
  tx: e.tx,
});

const toTickets = (j: Raw): TicketInfo => ({
  wallet: j.wallet,
  handle: j.handle ?? null,
  balance: wei(j.balance),
  minBalance: wei(j.minBalance ?? j.balance),
  tickets: int(j.tickets),
  totalTickets: int(j.totalTickets),
});

/** back off while the endpoint is missing or down */
const every = (ms: number) => (q: { state: { status: string } }) => (q.state.status === "error" ? 20_000 : ms);
const POLL = FIXTURE ? 1_000 : 4_000;
/** the fixture needs no network */
const networkMode = FIXTURE ? ("always" as const) : ("online" as const);

export function useRaffle() {
  return useQuery({
    queryKey: ["raffle", GATEWAY, FIXTURE],
    enabled: LIVE,
    networkMode,
    retry: 0,
    staleTime: 0,
    refetchInterval: every(POLL),
    queryFn: async (): Promise<RaffleState> => {
      return toState(FIXTURE ? await (await fixture()).raffleState() : await get<Raw>("/v1/raffle"));
    },
  });
}

export function useRaffleFeed() {
  return useQuery({
    queryKey: ["raffle-feed", GATEWAY, FIXTURE],
    enabled: LIVE,
    networkMode,
    retry: 0,
    staleTime: 0,
    refetchInterval: every(POLL),
    queryFn: async (): Promise<FeedEvent[]> => {
      const j = FIXTURE ? await (await fixture()).raffleFeed() : await get<Raw>("/v1/raffle/feed");
      return list(j.events).map(toEvent);
    },
  });
}

/** id: 0x address, `name` or `name.ai` */
export function useTickets(id?: string) {
  return useQuery({
    queryKey: ["raffle-tickets", GATEWAY, FIXTURE, id],
    enabled: !!id && LIVE,
    networkMode,
    retry: 0,
    refetchInterval: 30_000,
    queryFn: async (): Promise<TicketInfo> =>
      toTickets(FIXTURE ? await (await fixture()).tickets(id!) : await get<Raw>(`/v1/raffle/tickets/${encodeURIComponent(id!)}`)),
  });
}
