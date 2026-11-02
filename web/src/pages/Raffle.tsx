import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type MutableRefObject, type ReactNode } from "react";
import { useT } from "../i18n";
import { explorer, fmt, short } from "../chain";
import { useRaffle, useRaffleFeed, useTickets, NotFoundError, LIVE, type FeedEvent, type RaffleDraw, type RafflePot, type RaffleState, type TicketInfo } from "../raffle/data";
import { createMotes, createScene, type Motes, type VesselScene } from "../raffle/scene";
import { sfx } from "../raffle/sfx";
import "../styles/raffle.css";

// 天选. Three vessels fill from mints and sales. A full vessel opens: the ticket list is committed on-chain,
// Chainlink VRF picks a ticket, and the prize goes to that wallet. The stage replays each draw from gateway state.

/** by pot index; the brush names and ranks stay Chinese in both languages */
const POTS = [
  { key: "jade", zh: "青罐", rank: "中签", c: "#9fd1b8", tc: "#9fd1b8", threshold: 20_000, flow: "20,000", tax: "40%", every: "rf_e1", draws: "1,000" },
  { key: "cin", zh: "朱瓶", rank: "上签", c: "#ff7a5c", tc: "#ff7a5c", threshold: 100_000, flow: "10,000", tax: "20%", every: "rf_e2", draws: "100" },
  { key: "gold", zh: "金鼎", rank: "上上签", c: "#f0c96a", tc: "#e9c36a", threshold: 1_000_000, flow: "20,000", tax: "40%", every: "rf_e3", draws: "20" },
] as const;
/** altar order, left to right */
const ORDER = [0, 2, 1];
const FEED_CLS = ["j", "s", "g"];
// per pot: shake clacks, minimum reel time, deceleration, confetti, how long the 喜报 stays up
const CLACKS = [7, 10, 15];
const SPIN = [1700, 2600, 3900];
const SLOW = [1300, 1900, 2800];
const BURST = [50, 100, 220];
const HOLD = [5500, 6500, 8000];
const SAVED = "raffle-lookup";
const BRUSH_FONT = "https://fonts.googleapis.com/css2?family=Ma+Shan+Zheng&display=swap";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const pick = <T,>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)];
const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(" ");
const num = (n: number) => Math.round(n).toLocaleString("en-US");
const wad = (w?: string | null) => {
  try {
    return w ? BigInt(w) : 0n;
  } catch {
    return 0n;
  }
};
/** wei string → YAN as a float, for display and tweening */
const yan = (w?: string | null) => Number(wad(w) / 10n ** 12n) / 1e6;
const who = (handle?: string | null, wallet?: string | null) => (handle ? `${handle}.ai` : wallet ? short(wallet, 4) : "");
const hexShort = (h: string) => `${h.slice(0, 10)}…${h.slice(-4)}`;
const prizeShort = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}K` : num(n));
const hex4 = () => Math.floor(Math.random() * 65536).toString(16).padStart(4, "0");
/** reel filler while there are too few real names */
const PLACEHOLDERS = Array.from({ length: 24 }, () => `0x${hex4()}…${hex4()}`);
const feedKey = (e: FeedEvent) => `${e.tx}:${e.kind}:${e.wallet}:${e.amount}`;
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** "{a} 与 {b}" with nodes in the slots */
function fill(s: string, v: Record<string, ReactNode>): ReactNode {
  return s.split(/\{(\w+)\}/).map((part, i) => (i % 2 ? <Fragment key={i}>{v[part]}</Fragment> : part));
}
const fillText = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ""));

function useNow(ms: number) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** eased count toward `target`, a beat after it changes (coins land first) */
function useTween(target: number, instant: boolean) {
  const [v, setV] = useState(target);
  const cur = useRef(target);
  useEffect(() => {
    const from = cur.current;
    if (from === target) return;
    if (instant) {
      cur.current = target;
      setV(target);
      return;
    }
    let raf = 0;
    const timer = setTimeout(() => {
      const t0 = performance.now();
      const step = (now: number) => {
        const k = Math.min((now - t0) / 900, 1);
        cur.current = from + (target - from) * (1 - Math.pow(1 - k, 3));
        setV(cur.current);
        if (k < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    }, 450);
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(raf);
    };
  }, [target, instant]);
  return v;
}

function useBrushFont() {
  useEffect(() => {
    if (document.querySelector("link[data-brush]")) return;
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = BRUSH_FONT;
    l.dataset.brush = "";
    document.head.appendChild(l);
  }, []);
}

interface Job {
  id: number;
  pot: number;
  /** first seen already settled: replay it in full */
  missed: boolean;
}
interface Slip {
  pot: number;
  up: boolean;
  out: boolean;
  stamped: boolean;
}
interface Card {
  draw: RaffleDraw;
  no: number | null;
  mine: boolean;
}

interface StageRefs {
  stage: MutableRefObject<HTMLElement | null>;
  views: MutableRefObject<(HTMLDivElement | null)[]>;
  clips: MutableRefObject<(HTMLDivElement | null)[]>;
  names: MutableRefObject<(HTMLSpanElement | null)[]>;
  scene: MutableRefObject<VesselScene | null>;
  motes: MutableRefObject<Motes | null>;
}

/**
 * The live-draw director. Each poll of /v1/raffle is diffed against the draws already seen:
 * - a pot whose activeDraw is committed or random queues an opening that spins until the draw settles;
 * - a draw first seen already settled (after the first load) queues a full replay;
 * - draws settled before the page loaded go straight into the roll; void draws are ignored.
 * Openings play one at a time. A queued draw is held out of the roll and the stats until its stamp lands.
 */
function useDirector(state: RaffleState | undefined, refs: StageRefs, reelNames: MutableRefObject<string[]>, mineWallet: MutableRefObject<string | undefined>, reduce: boolean) {
  const [active, setActive] = useState<number | null>(null);
  const [mark, setMark] = useState(2);
  const [hold, setHold] = useState<number | null>(null);
  const [slip, setSlip] = useState<Slip | null>(null);
  const [flash, setFlash] = useState(false);
  const [jolt, setJolt] = useState(false);
  const [card, setCard] = useState<Card | null>(null);
  const [cardOn, setCardOn] = useState(false);
  const [held, setHeld] = useState<ReadonlySet<number>>(() => new Set());
  const [fresh, setFresh] = useState<ReadonlySet<number>>(() => new Set());
  const stateRef = useRef(state);
  stateRef.current = state;
  const known = useRef<Set<number> | null>(null);
  const jobs = useRef<Job[]>([]);
  const hover = useRef(false);

  useEffect(() => {
    if (!state) return;
    const first = known.current === null;
    const seen = (known.current ??= new Set());
    const opening = new Set(state.pots.map((p) => p.activeDraw).filter(Boolean));
    const add: Job[] = [];
    for (const d of [...state.draws].reverse()) {
      if (seen.has(d.id)) continue;
      if (d.status === "void") seen.add(d.id);
      else if (d.status === "settled") {
        seen.add(d.id);
        if (!first) add.push({ id: d.id, pot: d.pot, missed: true });
      } else if (opening.has(d.id)) {
        seen.add(d.id);
        add.push({ id: d.id, pot: d.pot, missed: false });
      }
    }
    // an active draw the list doesn't carry yet
    for (const p of state.pots) {
      if (p.activeDraw && !seen.has(p.activeDraw)) {
        seen.add(p.activeDraw);
        add.push({ id: p.activeDraw, pot: p.index, missed: false });
      }
    }
    if (!add.length) return;
    jobs.current.push(...add);
    // coming back after a long absence: replay the newest three missed draws, show the rest at once
    const missed = jobs.current.filter((j) => j.missed);
    const skip = new Set(missed.slice(0, Math.max(0, missed.length - 3)).map((j) => j.id));
    jobs.current = jobs.current.filter((j) => !skip.has(j.id));
    setHeld((h) => {
      const n = new Set(h);
      add.forEach((j) => n.add(j.id));
      skip.forEach((id) => n.delete(id));
      return n;
    });
  }, [state]);

  useEffect(() => {
    let alive = true;
    const live = () => alive;
    const release = (id: number, animate: boolean) => {
      setHeld((h) => {
        const n = new Set(h);
        n.delete(id);
        return n;
      });
      if (animate) setFresh((f) => new Set(f).add(id));
    };
    const drawNo = (d: RaffleDraw) => {
      const s = stateRef.current;
      const p = s?.pots.find((x) => x.index === d.pot);
      if (!s || !p) return null;
      return p.opened - s.draws.filter((x) => x.pot === d.pot && x.status === "settled" && x.id > d.id).length;
    };
    const burst = (pot: number) => {
      const st = refs.stage.current;
      const view = refs.views.current[pot];
      if (!st || !view || !refs.motes.current) return;
      const s = st.getBoundingClientRect();
      const r = view.getBoundingClientRect();
      const mb = refs.scene.current?.mouthOffset(pot) || r.height * 0.4;
      const clipH = refs.clips.current[pot]?.offsetHeight ?? 0;
      refs.motes.current.burst(r.left - s.left + r.width / 2, r.bottom - s.top - mb - clipH * 0.5, BURST[pot], [POTS[pot].c, "#fff3dc", "#c3301c", "#f0c96a"], pot === 2 ? 12 : 7);
    };

    const play = async (job: Job) => {
      const pot = job.pot;
      const sc = () => refs.scene.current;
      const el = refs.names.current[pot];
      const set = (n: string, mine = false) => {
        if (!el) return;
        el.textContent = n;
        el.style.setProperty("--len", String(Math.max(n.length, 7)));
        el.classList.toggle("mine", mine);
      };
      const current = () => stateRef.current?.draws.find((d) => d.id === job.id);
      const names = () => reelNames.current;

      setMark(pot);
      setActive(pot);
      setHold(pot);
      sc()?.setActive(pot);
      sc()?.surge(pot, 0.6);
      set("");
      setSlip({ pot, up: false, out: false, stamped: false });
      if (!reduce) {
        sc()?.setShake(pot, true);
        for (let i = 0; i < CLACKS[pot] && live(); i++) {
          sfx.clack();
          await wait(105);
        }
        sc()?.setShake(pot, false);
      }
      if (!live()) return;
      setSlip({ pot, up: true, out: false, stamped: false });
      sfx.whoosh();
      await wait(reduce ? 0 : 650);

      // spin until the draw settles (at least SPIN ms); a void draw closes the vessel again
      const t0 = performance.now();
      let d = current();
      for (let n = 0; live(); n++) {
        d = current();
        if (d?.status === "void") break;
        if (d?.status === "settled" && performance.now() - t0 >= (reduce ? 0 : SPIN[pot])) break;
        if (reduce) set("…");
        else {
          set(pick(names()));
          if (n % 2 === 0) sfx.tick();
        }
        await wait(reduce ? 300 : 45);
      }
      if (!live()) return;

      if (d?.status === "settled" && d.winner) {
        if (!reduce) {
          const t1 = performance.now();
          let gap = 45;
          while (live() && performance.now() - t1 < SLOW[pot]) {
            set(pick(names()));
            sfx.tick();
            await wait(gap);
            gap = 45 + Math.pow((performance.now() - t1) / SLOW[pot], 2.2) * 330;
          }
        }
        if (!live()) return;
        const won = current() ?? d;
        const mine = !!mineWallet.current && won.winner?.toLowerCase() === mineWallet.current;
        set(who(won.handle, won.winner), mine);
        setSlip({ pot, up: true, out: true, stamped: true });
        setHold(null);
        sfx.thud();
        sc()?.surge(pot, 1.4);
        if (pot === 2) {
          sfx.gong();
          setFlash(true);
          sc()?.beam(true);
        } else sfx.chime();
        if (!reduce) {
          setJolt(true);
          setTimeout(() => setJolt(false), 220);
          burst(pot);
        }
        setCard({ draw: won, no: drawNo(won), mine });
        setCardOn(true);
        release(won.id, true);
        await wait(HOLD[pot]);
        // keep the card up while the pointer is on it, so the tx link can be followed
        for (let w = 0; live() && hover.current && w < 20_000; w += 250) await wait(250);
        setCardOn(false);
        setSlip({ pot, up: false, out: false, stamped: true });
        sc()?.beam(false);
      } else {
        setSlip({ pot, up: false, out: false, stamped: false });
      }
      sc()?.surge(pot, 0);
      await wait(550);
      setSlip(null);
      setActive(null);
      setHold(null);
      setFlash(false);
      sc()?.setActive(null);
      await wait(400);
    };

    (async () => {
      while (alive) {
        const job = jobs.current.shift();
        if (!job) {
          await wait(250);
          continue;
        }
        while (alive && document.hidden) await wait(500);
        if (!alive) break;
        await play(job);
        release(job.id, false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return { active, mark, hold, slip, flash, jolt, card, cardOn, held, fresh, hover };
}

export default function Raffle() {
  const { t, lang } = useT();
  const zh = lang === "zh";
  const [reduce] = useState(reducedMotion);
  const raffle = useRaffle();
  const feed = useRaffleFeed();
  const s = raffle.data;
  const now = useNow(30_000);
  useBrushFont();

  // the remembered lookup
  const [lookup, setLookup] = useState<string | undefined>(() => {
    try {
      return localStorage.getItem(SAVED) || undefined;
    } catch {
      return undefined;
    }
  });
  const [q, setQ] = useState(lookup ?? "");
  const [formErr, setFormErr] = useState<"empty" | "bad" | null>(null);
  const mine = useTickets(lookup);
  const mineWallet = useRef<string | undefined>(undefined);
  mineWallet.current = mine.data?.wallet?.toLowerCase();
  // forget a name the registry doesn't know (a 404 only means that while the raffle endpoint answers)
  const unknownName = mine.error instanceof NotFoundError && !!raffle.data;
  useEffect(() => {
    if (unknownName)
      try {
        localStorage.removeItem(SAVED);
      } catch {}
  }, [unknownName]);

  // names for the reel: recent minters, sellers and winners
  const reelNames = useRef<string[]>(PLACEHOLDERS);
  const names = useMemo(() => {
    const set = new Set<string>();
    (feed.data ?? []).forEach((e) => set.add(who(e.handle, e.wallet)));
    (s?.draws ?? []).forEach((d) => d.winner && set.add(who(d.handle, d.winner)));
    set.delete("");
    return [...set];
  }, [feed.data, s]);
  reelNames.current = names.length >= 3 ? names : [...names, ...PLACEHOLDERS];

  // the stage: WebGL vessels and the 2D motes overlay
  const stageRef = useRef<HTMLElement | null>(null);
  const vesselsRef = useRef<HTMLDivElement>(null);
  const motesCanvas = useRef<HTMLCanvasElement>(null);
  const views = useRef<(HTMLDivElement | null)[]>([]);
  const clips = useRef<(HTMLDivElement | null)[]>([]);
  const slipNames = useRef<(HTMLSpanElement | null)[]>([]);
  const scene = useRef<VesselScene | null>(null);
  const motes = useRef<Motes | null>(null);
  const levels = useRef([0, 0, 0]);
  const [noGl, setNoGl] = useState(false);
  const [sound, setSound] = useState(false);

  useEffect(() => {
    const sc = createScene(vesselsRef.current!, views.current as HTMLElement[], { reduce, onCoin: sfx.coin, onGl: (ok) => setNoGl(!ok) });
    scene.current = sc;
    setNoGl(!sc);
    levels.current.forEach((l, i) => sc?.setLevel(i, l));
    const m = createMotes(motesCanvas.current!, stageRef.current!, reduce);
    motes.current = m;
    return () => {
      sc?.dispose();
      m.dispose();
      scene.current = null;
      motes.current = null;
      sfx.set(false);
    };
  }, [reduce]);

  const dir = useDirector(s, { stage: stageRef, views, clips, names: slipNames, scene, motes }, reelNames, mineWallet, reduce);
  const drawing = useRef(false);
  drawing.current = dir.active !== null;

  // the live ticker: each new feed event shows in turn and drops coins into the vessels (held while one opens)
  const [tick, setTick] = useState<FeedEvent | null>(null);
  const feedSeen = useRef<Set<string> | null>(null);
  const feedQueue = useRef<FeedEvent[]>([]);
  useEffect(() => {
    const ev = feed.data;
    if (!ev) return;
    const first = feedSeen.current === null;
    const seen = (feedSeen.current ??= new Set());
    const incoming = ev.filter((e) => !seen.has(feedKey(e)));
    incoming.forEach((e) => seen.add(feedKey(e)));
    if (first) {
      if (ev[0]) setTick(ev[0]);
      return;
    }
    feedQueue.current.push(...incoming.reverse().slice(-6));
  }, [feed.data]);
  useEffect(() => {
    let alive = true;
    (async () => {
      while (alive) {
        const e = feedQueue.current.shift();
        if (!e) {
          await wait(300);
          continue;
        }
        setTick(e);
        if (!drawing.current)
          POTS.forEach((_, i) => {
            const add = yan(e.adds?.[i]);
            if (add > 0) scene.current?.dropCoins(i, Math.min(6, 1 + Math.floor(add / 2200)));
          });
        await wait(900);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // stats hold back draws whose stamp hasn't landed yet
  const pendingSettled = (s?.draws ?? []).filter((d) => d.status === "settled" && dir.held.has(d.id));
  const drawsShown = s ? s.drawsSettled - pendingSettled.length : undefined;
  const paidShown = s ? wad(s.paidOut) - pendingSettled.reduce((a, d) => a + wad(d.prize), 0n) : undefined;
  const roll = (s?.draws ?? []).filter((d) => d.status === "settled" && !dir.held.has(d.id) && POTS[d.pot]);

  const ago = (sec: number | null) => {
    if (!sec) return "";
    const m = Math.max(0, Math.floor((now / 1000 - sec) / 60));
    if (m === 0) return t("rf_ago_now");
    if (m < 60) return fillText(t("rf_ago_m"), { n: m });
    if (m < 1440) return fillText(t("rf_ago_h"), { n: Math.round(m / 60) });
    return fillText(t("rf_ago_d"), { n: Math.round(m / 1440) });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = q.trim().toLowerCase();
    if (!v) return setFormErr("empty");
    const isAddr = /^0x[0-9a-f]{40}$/.test(v);
    if (!isAddr && !/^[a-z0-9-]{1,40}(\.ai)?$/.test(v)) return setFormErr("bad");
    setFormErr(null);
    const id = isAddr ? v : `${v.replace(/\.ai$/, "")}.ai`;
    setLookup(id);
    try {
      localStorage.setItem(SAVED, id);
    } catch {}
  };

  const toggleSound = () => {
    sfx.set(!sfx.on);
    setSound(sfx.on);
  };

  const mineLabel = mine.data ? who(mine.data.handle, mine.data.wallet) : "";

  return (
    <div className="raffle-page" data-lang={lang}>
      <section
        ref={stageRef}
        className={cx("stage", dir.active !== null && "drawing", dir.flash && "flash", dir.jolt && "jolt", noGl && "no-gl")}
        style={{ "--mark": POTS[dir.mark].c } as CSSProperties}
        aria-label={t("rf_stage")}
      >
        <div className="stage-mark" aria-hidden>{POTS[dir.mark].rank}</div>
        <canvas className="motes" ref={motesCanvas} aria-hidden />
        <div className="stage-in">
          <div className="wrap stage-top">
            <span className="eyebrow">{t("rf_eyebrow")}</span>
            <div className="feed">
              <FeedRow e={tick} />
            </div>
            {mine.data ? <div className="mine-chip">{fill(t("rf_chip"), { w: <b>{mineLabel}</b>, n: num(mine.data.tickets) })}</div> : null}
            <button type="button" className="sound" aria-pressed={sound} onClick={toggleSound}>
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
                <path d="M2 6h3l4-3v10l-4-3H2z" fill="currentColor" />
                {sound ? (
                  <path d="M11 5.6a3.4 3.4 0 0 1 0 4.8M12.9 3.7a6 6 0 0 1 0 8.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" fill="none" />
                ) : (
                  <path d="M11 6l3.6 4M14.6 6L11 10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                )}
              </svg>
              {t(sound ? "rf_sound_on" : "rf_sound_off")}
            </button>
          </div>
          <div className="wrap title">
            <h1>天选</h1>
            <p>{t("rf_tagline")}</p>
            <small>{t("rf_sub")}</small>
          </div>
          <div className="wrap">
            <div className="vessels" ref={vesselsRef}>
              {ORDER.map((i) => {
                const p = POTS[i];
                const sl = dir.slip?.pot === i ? dir.slip : null;
                return (
                  <div key={p.key} className="view" data-k={p.key} data-name={p.zh} style={{ "--c": p.c } as CSSProperties} aria-hidden ref={(el) => void (views.current[i] = el)}>
                    <div className={cx("slip-clip", sl?.up && "up", sl?.out && "out", sl?.stamped && "stamped")} ref={(el) => void (clips.current[i] = el)}>
                      <div className={p.key === "gold" ? "slip gold" : "slip"}>
                        <span className="slip-rank">{p.rank}</span>
                        <span className="slip-name" ref={(el) => void (slipNames.current[i] = el)} />
                        <span className="stamp">天选</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="altar-top" />
          <div className="altar-front">
            <div className="wrap">
              <div className="infos">
                {ORDER.map((i) => (
                  <PotInfo key={i} i={i} pot={s?.pots.find((p) => p.index === i)} active={dir.active === i} hold={dir.hold === i} levels={levels} scene={scene} reduce={reduce} />
                ))}
              </div>
            </div>
          </div>
          <div className="base">
            <div className="wrap">
              <span>{t("rf_s_holders")}<b>{s ? num(s.holders) : "—"}</b></span>
              <span>{t("rf_s_tickets")}<b>{s ? num(s.totalTickets) : "—"}</b></span>
              <span>{t("rf_s_draws")}<b>{drawsShown === undefined ? "—" : num(drawsShown)}</b></span>
              <span>{t("rf_s_paid")}<b>{paidShown === undefined ? "—" : fmt(paidShown, 18, 0)}</b> YAN</span>
            </div>
          </div>
          <div
            className={cx("xibao", dir.cardOn && "show")}
            aria-live="polite"
            aria-hidden={!dir.cardOn}
            onPointerEnter={() => (dir.hover.current = true)}
            onPointerLeave={() => (dir.hover.current = false)}
          >
            {dir.card ? <CardBody card={dir.card} /> : null}
          </div>
        </div>
      </section>

      <section className="wrap hall">
        <Head no="壹" h={t("rf_mine_h")} p={t("rf_mine_p")} />
        <div className="lookup">
          <form className="check" onSubmit={submit} noValidate>
            <label htmlFor="rf-q">{t("rf_look_label")}</label>
            <div className="row">
              <input id="rf-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("rf_look_ph")} autoComplete="off" spellCheck={false} />
              <button className="seal-btn" type="submit">{t("rf_look_btn")}</button>
            </div>
            <LookupOut formErr={formErr} lookup={lookup} q={mine} state={s} label={mineLabel} />
          </form>
          <div className="tube-wrap">
            <Tube n={mine.data ? mine.data.tickets : 12} label={t("rf_tube")} />
            <div className="tube-num">
              <b>{mine.data ? num(mine.data.tickets) : "12"}</b>
              <span>{t(mine.data?.tickets === 1 ? "rf_unit_1" : "rf_unit_n")}</span>
              <small>{mine.data ? `${mineLabel} · ${fmt(wad(mine.data.balance), 18, 0)} YAN` : t("rf_tube_example")}</small>
            </div>
          </div>
        </div>
      </section>

      <section className="wrap hall">
        <Head no="贰" h={t("rf_roll_h")} p={t("rf_roll_p")} />
        <div className="roll">
          <div className="roll-in">
            <div className="col head">
              <span className="bang">金榜</span>
              <span className="sub">天选题名</span>
            </div>
            {roll.map((d) => {
              const p = POTS[d.pot];
              const name = who(d.handle, d.winner);
              const cls = cx("col", p.key, dir.fresh.has(d.id) && "new", !!mineWallet.current && d.winner?.toLowerCase() === mineWallet.current && "mine");
              const body = (
                <>
                  <span className="r">{p.rank}</span>
                  <span className="n" style={{ "--len": Math.max(name.length, 8) } as CSSProperties}>{name}</span>
                  <span className="p">{prizeShort(yan(d.prize))}</span>
                  <span className="t">
                    {t(`rf_${p.key}_s`)}
                    <br />
                    {ago(d.settledAt)}
                  </span>
                </>
              );
              return explorer && d.settleTx ? (
                <a key={d.id} className={cls} href={`${explorer}/tx/${d.settleTx}`} target="_blank" rel="noreferrer">{body}</a>
              ) : (
                <div key={d.id} className={cls}>{body}</div>
              );
            })}
            {s && !roll.length ? (
              <div className="col wait">
                <span className="vac">虚位以待</span>
                <span className="sub">{t("rf_roll_empty")}</span>
              </div>
            ) : null}
            <div className="col fill" aria-hidden />
          </div>
        </div>
      </section>

      <section className="wrap hall">
        <Head no="叁" h={t("rf_rules_h")} p={t("rf_rules_p")} />
        <div className="rules">
          {([1, 2, 3] as const).map((n) => (
            <div key={n}>
              <h3>{t(`rf_r${n}h`)}</h3>
              <p>{t(`rf_r${n}p`)}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="wrap hall">
        <Head no="肆" h={t("rf_pots_h")} p={t("rf_pots_p")} />
        <div className="tbl">
          <table>
            <thead>
              <tr>
                <th>{t("rf_th1")}</th>
                <th>{t("rf_th2")}</th>
                <th className="num">{t("rf_th3")}</th>
                <th className="num">{t("rf_th4")}</th>
                <th className="num">{t("rf_th5")}</th>
                <th className="num">{t("rf_th6")}</th>
                <th className="num">{t("rf_th7")}</th>
              </tr>
            </thead>
            <tbody>
              {POTS.map((p) => (
                <tr key={p.key} style={{ "--tc": p.tc } as CSSProperties}>
                  <td className="vn">
                    <span className="vz">{p.zh}</span>
                    {zh ? null : <span className="ve">{t(`rf_${p.key}`)}</span>}
                  </td>
                  <td className="rk">{t(`rf_rk_${p.key}`)}</td>
                  <td className="num">{p.flow}</td>
                  <td className="num">{p.tax}</td>
                  <td className="num">{num(p.threshold)}</td>
                  <td className="num">{t(p.every)}</td>
                  <td className="num">{p.draws}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}>{t("rf_total")}</td>
                <td className="num">50,000</td>
                <td className="num">{t("rf_tax_total")}</td>
                <td />
                <td />
                <td className="num">{t("rf_draws_total")}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>
    </div>
  );
}

function Head({ no, h, p }: { no: string; h: string; p: string }) {
  return (
    <div className="hall-h">
      <span className="no">{no}</span>
      <div>
        <h2>{h}</h2>
        <p>{p}</p>
      </div>
    </div>
  );
}

function FeedRow({ e }: { e: FeedEvent | null }) {
  const { t } = useT();
  if (!e)
    return (
      <span className="row">
        <i className="ping" />
        {t("rf_waiting")}
      </span>
    );
  return (
    <span className="row" key={feedKey(e)}>
      <i className="ping" />
      {fillText(t("rf_block"), { n: num(e.block) })}
      {"　"}
      {fill(t(e.kind === "sell" ? "rf_sold" : "rf_minted"), { w: <b>{who(e.handle, e.wallet)}</b>, n: num(yan(e.amount)) })}
      {ORDER.map((i) => (
        <Fragment key={i}>
          {"　"}
          <span className={FEED_CLS[i]}>
            {t(`rf_tk_${POTS[i].key}`)} +{num(yan(e.adds?.[i]))}
          </span>
        </Fragment>
      ))}
    </span>
  );
}

function PotInfo({ i, pot, active, hold, levels, scene, reduce }: { i: number; pot?: RafflePot; active: boolean; hold: boolean; levels: MutableRefObject<number[]>; scene: MutableRefObject<VesselScene | null>; reduce: boolean }) {
  const { t } = useT();
  const p = POTS[i];
  const thr = yan(pot?.threshold) || p.threshold;
  const bal = pot ? yan(pot.balance) : undefined;
  // while its draw is opening, a vessel reads full until the stamp lands
  const target = bal === undefined ? 0 : hold ? Math.max(bal, thr) : bal;
  const shown = useTween(target, reduce);
  const lvl = Math.min(Math.max(shown / thr, 0), 1);
  const nOn = Math.min(10, Math.floor(lvl * 10 + 1e-6));
  const prevOn = useRef(-1);
  useEffect(() => {
    if (prevOn.current >= 0 && nOn > prevOn.current) sfx.bead();
    prevOn.current = nOn;
  }, [nOn]);
  useEffect(() => {
    levels.current[i] = lvl;
    scene.current?.setLevel(i, lvl);
  }, [lvl, i, levels, scene]);
  const left = Math.max(thr - shown, 0);
  return (
    <div className={cx("info", active && "active", lvl >= 0.9 && "near")} style={{ "--c": p.c } as CSSProperties}>
      <div className="plaque">
        <b>{p.zh}</b>
        <span>{fillText(t("rf_plaque"), { rank: t(`rf_rk_${p.key}`), name: t(`rf_${p.key}`), n: num(thr) })}</span>
      </div>
      <div className="beads" aria-hidden>
        <i className="rod" />
        {Array.from({ length: 10 }, (_, k) => (
          <i key={k} className={k < nOn ? "bead on" : "bead"} style={{ left: `${k < nOn ? k * 8 : 100 - (10 - k) * 8}%` }} />
        ))}
      </div>
      <div className="nums">
        <b>{bal === undefined ? "—" : num(shown)}</b>
        <span>/ {num(thr)}</span>
      </div>
      <div className="meta">
        <span className="left">{bal === undefined ? "—" : left > 0.5 ? fillText(t("rf_left"), { n: num(left) }) : t("rf_full")}</span>
        <span className="count">{fillText(t("rf_opened"), { n: pot ? num(pot.opened) : "—" })}</span>
      </div>
    </div>
  );
}

function CardBody({ card }: { card: Card }) {
  const { t } = useT();
  const d = card.draw;
  const p = POTS[d.pot];
  const tx = d.settleTx ? (explorer ? <a href={`${explorer}/tx/${d.settleTx}`} target="_blank" rel="noreferrer">{hexShort(d.settleTx)}</a> : hexShort(d.settleTx)) : "—";
  return (
    <>
      <div className="xh">喜报</div>
      <div className="xs">{fillText(t("rf_xs"), { pot: t(`rf_${p.key}`), n: card.no === null ? "—" : num(card.no), rank: t(`rf_rk_${p.key}`) })}</div>
      <div className="xw">{who(d.handle, d.winner)}</div>
      <div className="xp">{fillText(t("rf_xp"), { n: fmt(wad(d.prize), 18, 0) })}</div>
      <div className="xs">{fill(t("rf_xauto"), { tx })}</div>
      <div className="xm">
        {fillText(t("rf_xm"), {
          r: d.random ? hexShort(d.random) : "—",
          k: d.winningTicket === null ? "—" : num(d.winningTicket),
          tot: num(d.totalTickets),
          h: d.winnerTickets === null ? "—" : num(d.winnerTickets),
        })}
      </div>
      {card.mine ? <div className="xme">{t("rf_xme")}</div> : null}
    </>
  );
}

function LookupOut({ formErr, lookup, q, state, label }: { formErr: "empty" | "bad" | null; lookup?: string; q: ReturnType<typeof useTickets>; state?: RaffleState; label: string }) {
  const { t } = useT();
  let cls = "";
  let body: ReactNode;
  if (formErr) {
    cls = "is-bad";
    body = t(formErr === "empty" ? "rf_look_empty" : "rf_look_bad");
  } else if (!lookup) body = t("rf_look_idle");
  else if (!LIVE || (q.error && !(q.error instanceof NotFoundError && state))) {
    cls = "is-bad";
    body = t("rf_look_err");
  } else if (q.error) {
    cls = "is-bad";
    body = fill(t("rf_look_404"), { l: <b>{lookup}</b> });
  } else if (!q.data) body = t("rf_look_wait");
  else {
    const d: TicketInfo = q.data;
    const unit = yan(state?.ticketUnit) || 10_000;
    const bal = yan(d.balance);
    const tot = d.totalTickets || state?.totalTickets || 0;
    // the count follows the lowest balance of the last hour; a recent rise counts later
    const rising = yan(d.minBalance) < bal && Math.floor(bal / unit) > d.tickets;
    const more = Math.ceil((d.tickets + 1) * unit - bal);
    const b = (v: ReactNode) => <b>{v}</b>;
    const tail = rising ? t("rf_look_hour") : fill(t(d.tickets > 0 ? "rf_look_more" : "rf_look_first"), { more: b(num(more)) });
    if (d.tickets > 0) {
      cls = "is-in";
      const pct = tot ? (d.tickets / tot) * 100 : 0;
      body = (
        <>
          {fill(t("rf_look_in"), { l: b(label), b: b(fmt(wad(d.balance), 18, 0)), t: b(num(d.tickets)), unit: t(d.tickets === 1 ? "rf_unit_1" : "rf_unit_n") })}
          <br />
          {fill(t("rf_look_odds"), { t: b(num(d.tickets)), tot: b(num(tot)), pct: pct >= 0.1 ? pct.toFixed(2) : pct.toFixed(3) })} {tail}
        </>
      );
    } else {
      cls = "is-warn";
      body = (
        <>
          {fill(t("rf_look_warn"), { l: b(label), b: b(fmt(wad(d.balance), 18, 0)) })} {tail}
        </>
      );
    }
  }
  return (
    <div className={cx("check-out", cls)} aria-live="polite">
      {body}
    </div>
  );
}

const h01 = (i: number) => {
  const s = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/** the lacquered ticket cylinder, one bamboo stick per ticket up to 30 */
function Tube({ n, label }: { n: number; label: string }) {
  const N = Math.max(0, Math.min(n, 30));
  return (
    <svg className="tube" viewBox="0 0 220 300" role="img" aria-label={label}>
      <defs>
        <linearGradient id="rf-bam" x1="0" x2="1">
          <stop offset="0" stopColor="#a7874a" />
          <stop offset=".5" stopColor="#ead59f" />
          <stop offset="1" stopColor="#a7874a" />
        </linearGradient>
        <linearGradient id="rf-lacq" x1="0" x2="1">
          <stop offset="0" stopColor="#2a0905" />
          <stop offset=".28" stopColor="#9c2617" />
          <stop offset=".42" stopColor="#c8442c" />
          <stop offset=".7" stopColor="#7a1a10" />
          <stop offset="1" stopColor="#1f0704" />
        </linearGradient>
      </defs>
      <ellipse cx="110" cy="128" rx="58" ry="12" fill="#120805" />
      {Array.from({ length: N }, (_, i) => {
        const k = N === 1 ? 0.5 : i / (N - 1);
        const ang = (k - 0.5) * 30 + (h01(i) - 0.5) * 5;
        const h = 148 + h01(i * 7 + 3) * 36;
        const x = 110 + (k - 0.5) * 60;
        return (
          <g key={i} transform={`rotate(${ang.toFixed(1)} ${x.toFixed(1)} 205)`}>
            <rect x={(x - 3).toFixed(1)} y={(205 - h).toFixed(1)} width="6" height={h.toFixed(1)} rx="1.5" fill="url(#rf-bam)" />
            <rect x={(x - 3).toFixed(1)} y={(205 - h).toFixed(1)} width="6" height="13" rx="1.5" fill="#c3301c" />
          </g>
        );
      })}
      <path d="M52 128 V276 Q52 292 110 292 Q168 292 168 276 V128 Q168 140 110 140 Q52 140 52 128 Z" fill="url(#rf-lacq)" />
      <path d="M52 154 Q52 166 110 166 Q168 166 168 154" stroke="#e9c36a" strokeWidth="2" fill="none" opacity=".85" />
      <path d="M52 262 Q52 274 110 274 Q168 274 168 262" stroke="#e9c36a" strokeWidth="2" fill="none" opacity=".85" />
      <ellipse cx="110" cy="128" rx="58" ry="12" fill="none" stroke="#e9c36a" strokeWidth="1.6" />
      <text x="110" y="228" textAnchor="middle" fontFamily="Ma Shan Zheng, KaiTi, serif" fontSize="40" fill="#e9c36a">
        {N ? "签" : "空"}
      </text>
    </svg>
  );
}
