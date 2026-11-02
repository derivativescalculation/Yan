// Small synthesized effects for the raffle stage. Silent until the viewer turns sound on.

let ctx: AudioContext | null = null;
let on = false;

function env(node: AudioNode, t: number, a: number, d: number, peak: number) {
  const g = ctx!.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  node.connect(g);
  g.connect(ctx!.destination);
}

function tone(f: number, d: number, peak: number, type: OscillatorType = "sine", t0 = 0) {
  if (!on || !ctx) return;
  const t = ctx.currentTime + t0;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  env(o, t, 0.004, d, peak);
  o.start(t);
  o.stop(t + d + 0.05);
}

function noise(d: number, peak: number, f: number, q = 6) {
  if (!on || !ctx) return;
  const t = ctx.currentTime;
  const len = Math.floor(ctx.sampleRate * d);
  const b = ctx.createBuffer(1, len, ctx.sampleRate);
  const ch = b.getChannelData(0);
  for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const s = ctx.createBufferSource();
  s.buffer = b;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = f;
  bp.Q.value = q;
  s.connect(bp);
  env(bp, t, 0.002, d, peak);
  s.start(t);
}

export const sfx = {
  get on() {
    return on;
  },
  set(v: boolean) {
    on = v;
    if (v && !ctx) {
      try {
        const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        ctx = new AC();
      } catch {
        on = false;
      }
    }
    if (ctx && on) ctx.resume().catch(() => {});
  },
  tick: () => tone(1900, 0.025, 0.03, "square"),
  coin: () => {
    tone(2600, 0.16, 0.02);
    tone(3900, 0.1, 0.011);
  },
  bead: () => {
    tone(1500, 0.04, 0.05, "triangle");
    noise(0.02, 0.15, 2400);
  },
  clack: () => noise(0.06, 0.5, 1100 + Math.random() * 300),
  whoosh: () => noise(0.3, 0.12, 700, 1.2),
  thud: () => {
    if (!on || !ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(46, t + 0.25);
    env(o, t, 0.004, 0.32, 0.6);
    o.start(t);
    o.stop(t + 0.4);
    noise(0.05, 0.3, 420);
  },
  chime: () => [1318.5, 1760, 2093].forEach((f, i) => tone(f, 0.7, 0.035, "sine", i * 0.08)),
  gong: () => [98, 147.5, 196.4, 262, 331].forEach((f, i) => tone(f, 3.4 - i * 0.45, 0.18 / (i + 1))),
};
