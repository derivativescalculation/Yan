// Dev-only fixture behind `?fixture=1`, for screenshot tests of the raffle page. It serves a history of
// settled draws, a live feed that adds an event every few seconds, and one scripted draw: the pot fills
// about 5 s after load, its draw commits at 6 s, gets its random number at 9.5 s and settles at 13 s.
// `&pot=0|1|2` picks the vessel that opens (default 2, the cauldron); `&commit=<s>` moves the whole script
// later so that a slow first frame (software GL in headless browsers) still leaves a quiet stage to capture.
// `&missed=1` hides the draw until it has settled, as if the page missed the opening (it replays in full).
import { NotFoundError, type FeedEvent, type PotKey, type RaffleDraw, type RaffleState, type TicketInfo } from "./data";

const params = new URLSearchParams(location.search);
const T0 = Date.now() + Math.max(0, (Number(params.get("commit")) || 6) - 6) * 1000;
const POT = (() => {
  const p = Number(params.get("pot") ?? 2);
  return p === 0 || p === 1 ? p : 2;
})();
const MISSED = params.get("missed") === "1";
const KEYS: PotKey[] = ["jade", "cin", "gold"];
const THRESH = [20_000, 100_000, 1_000_000];
const BASE = [3_000, 41_000, 724_000];
const OPENED = [724, 72, 14];
const BLOCK0 = 134_918_240;
const NAMES = ["kun", "qilin", "baize", "xuanwu", "zhuque", "atlas", "lumen", "orbit", "mira", "tao", "hexa", "sato", "yuan", "ming", "feng", "shan", "nova", "echo", "pangu", "nuwa", "fuxi", "crane", "ember", "quant"];
const COMMIT = 6_000;
const RANDOM = 9_500;
const SETTLE = 13_000;

const wei = (n: number) => (BigInt(Math.round(n * 1e6)) * 10n ** 12n).toString();
const yan = (w: string) => Number(BigInt(w) / 10n ** 12n) / 1e6;
const hash = (s: string) => {
  let h = 2166136261;
  for (const ch of s) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};
const hex = (seed: string, len: number) => {
  let h = hash(seed);
  let out = "";
  while (out.length < len) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
    out += h.toString(16).padStart(8, "0");
  }
  return out.slice(0, len);
};
const addr = (s: string) => `0x${hex("w" + s, 40)}` as `0x${string}`;
const txh = (s: string) => `0x${hex("t" + s, 64)}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// a mint puts 5% into the vessels (jade 2%, cinnabar 1%, gold 2%); a sale pays 0.5%, split 40 / 20 / 40
const split = (kind: "mint" | "sell", amt: number): [string, string, string] =>
  kind === "mint" ? [wei(amt * 0.02), wei(amt * 0.01), wei(amt * 0.02)] : [wei(amt * 0.002), wei(amt * 0.001), wei(amt * 0.002)];

const event = (kind: "mint" | "sell", who: string | null, amt: number, block: number): FeedEvent => ({
  kind,
  wallet: addr(who ?? "anon" + block),
  handle: who,
  amount: wei(amt),
  adds: split(kind, amt),
  block,
  tx: txh(`${kind}${block}`),
});

const OLDER: FeedEvent[] = [
  event("mint", "mira", 180_000, BLOCK0 - 6),
  event("sell", "orbit", 1_240_000, BLOCK0 - 14),
  event("mint", "kun", 95_000, BLOCK0 - 21),
  event("mint", null, 40_000, BLOCK0 - 33),
];
// the first two push the scripted pot over its threshold
const SCRIPT: ["mint" | "sell", string | null, number][] = [
  ["sell", "xuanwu", 400_000],
  ["mint", "qilin", 300_000],
  ["mint", "lumen", 120_000],
  ["sell", "sato", 860_000],
  ["mint", null, 45_000],
  ["mint", "zhuque", 210_000],
];

function newer(el: number): FeedEvent[] {
  const n = el < 1_500 ? 0 : Math.min(SCRIPT.length, Math.floor((el - 1_500) / 4_000) + 1);
  return SCRIPT.slice(0, n).map(([k, who, amt], i) => event(k, who, amt, BLOCK0 + 4 + i * 6));
}

// settled history, newest first: [pot, minutes ago, handle]; the void entry is skipped by the page
const HIST: [number, number, string | null][] = [
  [0, 4, "kun"], [0, 9, "mira"], [1, 15, "baize"], [0, 21, null], [0, 33, "lumen"], [0, 47, "tao"], [2, 62, "zhuque"], [0, 75, "orbit"],
  [0, 118, "hexa"], [1, 140, "sato"], [0, 172, "yuan"], [0, 196, null], [0, 250, "ming"], [0, 301, "feng"], [1, 362, "shan"], [0, 420, "nova"],
  [0, 485, "echo"], [2, 2_880, "pangu"],
];
const HISTORY: RaffleDraw[] = (() => {
  const out: RaffleDraw[] = [];
  let id = 811;
  HIST.forEach(([pot, mins, who], i) => {
    if (i === 6) out.push({ ...settled(--id, 1, 50, "fuxi"), status: "void", random: null, winningTicket: null, winner: null, handle: null, winnerTickets: null, settleTx: null, settledAt: null });
    out.push(settled(--id, pot, mins, who));
  });
  return out;
})();

function settled(id: number, pot: number, mins: number, who: string | null): RaffleDraw {
  const total = 43_000 + (hash(`n${id}`) % 900);
  return {
    id,
    pot,
    status: "settled",
    snapshotBlock: BLOCK0 - mins * 80 - 40,
    totalTickets: total,
    prize: wei(THRESH[pot]),
    random: `0x${hex(`r${id}`, 64)}`,
    winningTicket: 1 + (hash(`k${id}`) % total),
    winner: addr(who ?? `x${id}`),
    handle: who,
    winnerTickets: 1 + (hash(`h${id}`) % 380),
    commitTx: txh(`c${id}`),
    settleTx: txh(`s${id}`),
    settledAt: Math.floor(T0 / 1000) - mins * 60,
  };
}

function scripted(el: number): RaffleDraw | null {
  if (el < (MISSED ? SETTLE : COMMIT)) return null;
  const base = { ...settled(811, POT, 0, "qilin"), totalTickets: 43_886, snapshotBlock: BLOCK0 + 10, winningTicket: 36_003, winnerTickets: 400 };
  if (el >= SETTLE) return { ...base, settledAt: Math.floor((T0 + SETTLE) / 1000) };
  const pending = { winningTicket: null, winner: null, handle: null, winnerTickets: null, settleTx: null, settledAt: null };
  return { ...base, ...pending, status: el < RANDOM ? "committed" : "random", random: el < RANDOM ? null : base.random };
}

export async function raffleState(): Promise<RaffleState> {
  await wait(120);
  const el = Date.now() - T0;
  const adds = [0, 0, 0];
  newer(el).forEach((e) => e.adds.forEach((a, i) => (adds[i] += yan(a))));
  const d = scripted(el);
  const done = d?.status === "settled";
  const pots = KEYS.map((key, i) => {
    let bal = (i === POT ? THRESH[i] - 2_400 : BASE[i]) + adds[i];
    if (i === POT && done) bal -= THRESH[i];
    return {
      index: i,
      key,
      balance: wei(bal),
      threshold: wei(THRESH[i]),
      opened: OPENED[i] + (i === POT && done ? 1 : 0),
      fullAtBlock: bal >= THRESH[i] ? BLOCK0 + 10 : 0,
      activeDraw: i === POT && d && !done ? d.id : 0,
    };
  });
  return {
    raffle: addr("raffle"),
    token: addr("token"),
    ticketUnit: wei(10_000),
    holders: 1_208,
    totalTickets: 43_886,
    ticketsAsOfBlock: BLOCK0,
    pots,
    paidOut: wei(OPENED[0] * THRESH[0] + OPENED[1] * THRESH[1] + OPENED[2] * THRESH[2] + (done ? THRESH[POT] : 0)),
    drawsSettled: 810 + (done ? 1 : 0),
    draws: d ? [d, ...HISTORY] : HISTORY,
  };
}

export async function raffleFeed(): Promise<{ events: FeedEvent[] }> {
  await wait(80);
  return { events: [...newer(Date.now() - T0).reverse(), ...OLDER] };
}

export async function tickets(id: string): Promise<TicketInfo> {
  await wait(350);
  const v = id.toLowerCase().replace(/\.ai$/, "");
  const isAddr = /^0x[0-9a-f]{40}$/.test(v);
  if (!isAddr && !NAMES.includes(v)) throw new NotFoundError(`${v}.ai is not registered`);
  const h = hash(v);
  const bal = v === "qilin" ? 4_003_000 : h % 5 === 0 ? 6_500 : 35_000 + (h % 2_400_000);
  const min = v === "echo" ? bal - 25_000 : bal;
  return {
    wallet: isAddr ? (v as `0x${string}`) : addr(v),
    handle: isAddr ? null : v,
    balance: wei(bal),
    minBalance: wei(min),
    tickets: Math.floor(min / 10_000),
    totalTickets: 43_886,
  };
}
