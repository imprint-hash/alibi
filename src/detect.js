// Pure detectors. No I/O. Candles: [{t (sec, minute start), o, h, l, c}]. Prints: [{t, price, conf, publishTime}].
// liquidityAt(tSec) → 'closed' | 'thin' | 'core' is passed in, so everything here is testable on synthetic series.

export const clamp01 = (x) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
export const bps = (a, b) => (a / b - 1) * 1e4;
export function median(xs) {
  const a = xs.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
const byT = (cs) => new Map(cs.map((c) => [c.t, c]));
const pos = (x) => Number.isFinite(x) && x > 0;
/** Same-minute pairs where every value is a positive finite price (a zero/NaN print must not become a fake bps value). */
const pairsOf = (target, R, field) => target.filter((c) => R.has(c.t)).map((c) => ({ t: c.t, tv: fieldOf(c, field), tc: c.c, rv: fieldOf(R.get(c.t), field), rc: R.get(c.t).c })).filter((x) => pos(x.tv) && pos(x.tc) && pos(x.rv) && pos(x.rc));
const fieldOf = (c, field) => (field === 'high' ? c.h : field === 'low' ? c.l : c.c);

export const DEFAULTS = {
  basisLookback: 120, // minutes used for the rolling basis (target/ref ratio)
  divergenceFloorBps: 20, // below this, divergence is noise
  divergenceFullBps: 150,
  spikeBps: 40, // spike threshold vs the prior 5-minute median
  revertMinutes: 5,
  refFlatShare: 0.33, // refs must move less than this share of the spike to call it isolated
  repeatMinRun: 5,
  repeatFullRun: 30,
  staleGapSec: 120,
  staleFullSec: 1800,
  confRatio: 4,
  confFullRatio: 12,
};

/**
 * Divergence vs references in bps, same field and minute, after removing the rolling basis
 * (different contract months / venues trade at a spread; only changes in that spread are suspicious).
 */
export function divergence(target, refs, { field = 'close', settleT = null, ...o } = {}) {
  const p = { ...DEFAULTS, ...o };
  const perRef = [];
  for (const ref of refs) {
    const pairs = pairsOf(target, byT(ref.candles || []), field);
    if (pairs.length < 10) { perRef.push({ name: ref.name, n: pairs.length, insufficient: true }); continue; }
    let maxAbs = 0, at = null, atSettle = null, basisAtMax = null;
    const series = [];
    for (let i = 0; i < pairs.length; i++) {
      const lo = Math.max(0, i - p.basisLookback);
      const prior = pairs.slice(lo, Math.max(lo + 1, i - 2)); // exclude the last 2 minutes so a spike can't hide in its own basis
      const ratio = median((prior.length >= 5 ? prior : pairs.slice(0, Math.min(pairs.length, 30))).map((x) => x.tc / x.rc));
      const d = bps(pairs[i].tv, pairs[i].rv * ratio);
      series.push({ t: pairs[i].t, bps: d });
      if (Math.abs(d) > Math.abs(maxAbs)) { maxAbs = d; at = pairs[i].t; basisAtMax = ratio; }
      if (settleT != null && pairs[i].t === settleT) atSettle = d;
    }
    perRef.push({ name: ref.name, independent: !!ref.independent, n: pairs.length, maxAbsBps: round(maxAbs), at, atSettleBps: atSettle == null ? null : round(atSettle), basisRatio: basisAtMax, p95AbsBps: round(quantile(series.map((s) => Math.abs(s.bps)), 0.95)) });
  }
  const usable = perRef.filter((r) => !r.insufficient);
  // Use the reference that agrees best overall (lowest p95), so one noisy ref can't fake an alarm.
  const best = usable.sort((a, b) => a.p95AbsBps - b.p95AbsBps)[0] || null;
  const headline = settleT != null && best?.atSettleBps != null ? best.atSettleBps : best?.maxAbsBps ?? null;
  const severity = best ? clamp01((Math.abs(headline) - p.divergenceFloorBps) / (p.divergenceFullBps - p.divergenceFloorBps)) : 0;
  return { measured: !!best, perRef, best: best?.name || null, headlineBps: headline, atSettle: settleT != null, severity };
}

/** Spike-and-revert wicks: the field moves past the threshold and comes back within N minutes while references stay flat. */
export function spikeRevert(target, refs, o = {}) {
  const p = { ...DEFAULTS, ...o };
  const events = [];
  const refMaps = refs.map((r) => ({ name: r.name, M: byT(r.candles || []), list: r.candles || [] }));
  for (let i = 5; i < target.length; i++) {
    const base = median(target.slice(i - 5, i).map((c) => c.c));
    const c = target[i];
    if (!pos(base)) continue;
    for (const dir of ['up', 'down']) {
      const ext = dir === 'up' ? c.h : c.l;
      if (!pos(ext)) continue;
      const size = Math.abs(bps(ext, base));
      if (size < p.spikeBps || (dir === 'up' ? ext <= base : ext >= base)) continue;
      // revert: close within 1/3 of the threshold of base within N minutes (including this candle's close)
      let revertedAfter = null;
      for (let j = i; j < Math.min(target.length, i + 1 + p.revertMinutes); j++) {
        if (target[j].t - c.t > p.revertMinutes * 60) break;
        if (Math.abs(bps(target[j].c, base)) <= p.spikeBps * p.refFlatShare) { revertedAfter = (target[j].t - c.t) / 60; break; }
      }
      if (revertedAfter == null) continue;
      // reference move over the same minutes
      let refMove = null, refName = null;
      for (const r of refMaps) {
        const prior = [];
        for (let k = 1; k <= 5; k++) { const x = r.M.get(c.t - k * 60); if (x) prior.push(x.c); }
        if (prior.length < 2) continue;
        const rb = median(prior);
        let mv = 0;
        for (let k = 0; k <= Math.max(1, revertedAfter); k++) {
          const x = r.M.get(c.t + k * 60);
          if (x) mv = Math.max(mv, Math.abs(bps(dir === 'up' ? x.h : x.l, rb)), Math.abs(bps(x.c, rb)));
        }
        if (refMove == null || mv < refMove) { refMove = mv; refName = r.name; }
      }
      const isolated = refMove == null ? null : refMove < size * p.refFlatShare;
      events.push({ t: c.t, dir, sizeBps: round(size), base, extreme: ext, revertedAfterMin: revertedAfter, refMoveBps: refMove == null ? null : round(refMove), ref: refName, isolated });
    }
  }
  const isolated = events.filter((e) => e.isolated === true);
  const unconfirmed = events.filter((e) => e.isolated === null);
  const worst = [...isolated].sort((a, b) => b.sizeBps - a.sizeBps)[0] || null;
  const sevIso = worst ? clamp01(0.4 + (worst.sizeBps - p.spikeBps) / (4 * p.spikeBps)) : 0;
  const sevUnc = unconfirmed.length ? 0.25 : 0;
  return { measured: target.length > 5, events, isolatedCount: isolated.length, worst, severity: Math.max(sevIso, sevUnc) };
}

/** Repeated identical prints: flat candles (o=h=l=c) with the same value for minRun+ minutes while the venue is open. */
export function repeatedPrints(target, liquidityAt = () => 'core', o = {}) {
  const p = { ...DEFAULTS, ...o };
  const runs = [];
  let start = null, len = 0, val = null, prevT = null;
  const flush = () => { if (len >= p.repeatMinRun) runs.push({ start, end: prevT, minutes: len, value: val }); };
  for (const c of target) {
    const flat = c.o === c.h && c.h === c.l && c.l === c.c;
    const open = liquidityAt(c.t) !== 'closed';
    if (flat && open && val === c.c && prevT != null && c.t - prevT === 60) { len++; }
    else { flush(); if (flat && open) { start = c.t; len = 1; val = c.c; } else { start = null; len = 0; val = null; } }
    prevT = c.t;
  }
  flush();
  const maxRun = runs.reduce((m, r) => Math.max(m, r.minutes), 0);
  return { measured: target.length > 0, runs, maxRun, severity: maxRun ? clamp01((maxRun - p.repeatMinRun + 1) / (p.repeatFullRun - p.repeatMinRun + 1)) : 0 };
}

/** Staleness: missing minutes while open (candles) and publish-time gaps (prints). */
export function staleness(target, prints = [], liquidityAt = () => 'core', { from = null, to = null, samplingGapSec = Infinity, ...o } = {}) {
  const p = { ...DEFAULTS, ...o };
  const gaps = [];
  const ts = target.map((c) => c.t);
  const lo = from ?? ts[0], hi = to ?? ts[ts.length - 1];
  if (ts.length && lo != null) {
    const have = new Set(ts);
    let gs = null;
    for (let t = Math.ceil(lo / 60) * 60; t <= hi; t += 60) {
      const missing = !have.has(t) && liquidityAt(t) !== 'closed';
      if (missing && gs == null) gs = t;
      if (!missing && gs != null) { gaps.push({ from: gs, to: t, seconds: t - gs, kind: 'no-candle' }); gs = null; }
    }
    if (gs != null) gaps.push({ from: gs, to: hi + 60, seconds: hi + 60 - gs, kind: 'no-candle' });
  }
  const pt = prints.map((x) => x.publishTime).filter(Number.isFinite).sort((a, b) => a - b);
  for (let i = 1; i < pt.length; i++) {
    const g = pt[i] - pt[i - 1];
    if (g >= samplingGapSec) continue; // gap between sampled windows, not a feed gap
    if (g >= (o.printStaleSec ?? p.staleGapSec) && liquidityAt(pt[i - 1]) !== 'closed') gaps.push({ from: pt[i - 1], to: pt[i], seconds: g, kind: 'publish-gap' });
  }
  const maxGapSec = gaps.reduce((m, g) => Math.max(m, g.seconds), 0);
  return { measured: ts.length > 0 || pt.length > 0, gaps, maxGapSec, severity: maxGapSec >= p.staleGapSec ? clamp01((maxGapSec - p.staleGapSec) / (p.staleFullSec - p.staleGapSec) + 0.2) : 0 };
}

/** Confidence-interval blow-out: conf/price far above its own median. Needs prints with conf. */
export function confidenceBlowout(prints = [], o = {}) {
  const p = { ...DEFAULTS, ...o };
  const rel = prints.filter((x) => Number.isFinite(x.conf) && x.conf >= 0 && pos(x.price)).map((x) => ({ t: x.t, r: x.conf / x.price }));
  if (rel.length < 10) return { measured: false, severity: 0, note: 'needs Pyth prints with confidence (PYTH_API_KEY or local recording)' };
  const med = median(rel.map((x) => x.r));
  if (!(med > 0)) return { measured: false, severity: 0, note: 'Pyth confidence median is zero; no baseline to compare against' };
  const worst = rel.reduce((a, b) => (b.r > a.r ? b : a));
  const ratio = worst.r / med;
  const events = rel.filter((x) => x.r / med >= p.confRatio).map((x) => ({ t: x.t, ratio: round(x.r / med), confBps: round(x.r * 1e4) }));
  return { measured: true, medianConfBps: round(med * 1e4), worstConfBps: round(worst.r * 1e4), worstAt: worst.t, ratio: round(ratio), events, severity: ratio >= p.confRatio ? clamp01(0.3 + (ratio - p.confRatio) / (p.confFullRatio - p.confRatio)) : 0 };
}

/** Confidence (bps of price) around one minute, vs nothing else; for the settlement candle. */
export function confidenceAt(prints, tSec) {
  const w = prints.filter((x) => x.t >= tSec && x.t < tSec + 60 && Number.isFinite(x.conf) && pos(x.price));
  if (!w.length) return null;
  const pubs = w.map((x) => x.publishers).filter(Number.isFinite);
  return { t: tSec, medianConfBps: round(median(w.map((x) => (x.conf / x.price) * 1e4)), 2), maxConfBps: round(Math.max(...w.map((x) => (x.conf / x.price) * 1e4)), 2), minPublishers: pubs.length ? Math.min(...pubs) : null, prints: w.length };
}

/** Thin hours: share of window minutes in thin/closed periods, and the state at the settlement minute. */
export function thinHours(minutes, liquidityAt, settleT = null) {
  if (!minutes.length) return { measured: false, severity: 0 };
  const counts = { core: 0, thin: 0, closed: 0 };
  for (const t of minutes) counts[liquidityAt(t)]++;
  const open = counts.core + counts.thin;
  const thinShare = open ? counts.thin / open : 1;
  const settleState = settleT != null ? liquidityAt(settleT) : null;
  let severity = 0.3 * thinShare;
  if (settleState === 'thin') severity = 0.6 + 0.4 * thinShare;
  if (settleState === 'closed') severity = 1;
  return { measured: true, counts, thinShare: round(thinShare, 3), settleState, severity: clamp01(severity) };
}

/**
 * Distance of the current (or settling) price to the market threshold, in bps and in "typical moves".
 * typical move = median 1-minute range (bps) × sqrt(minutes left), floored at one minute.
 * Also says whether a glitch as large as the biggest isolated spike seen would flip the outcome.
 */
export function thresholdDistance({ price, threshold, comparator = '>', candles = [], minutesLeft = 0, worstSpikeBps = null }) {
  if (!pos(price) || !pos(threshold)) return { measured: false, severity: 0, note: 'no valid price or threshold' };
  const signed = bps(price, threshold); // + means above
  const winningSide = comparator.startsWith('>') ? signed > 0 || (comparator === '>=' && signed === 0) : signed < 0 || (comparator === '<=' && signed === 0);
  const ranges = candles.slice(-240).map((c) => bps(c.h, c.l)).filter((x) => x > 0);
  const typ1m = median(ranges);
  const typical = (Number.isFinite(typ1m) ? typ1m : 5) * Math.sqrt(Math.max(1, minutesLeft));
  const z = Math.abs(signed) / Math.max(typical, 0.5);
  const glitchCouldFlip = worstSpikeBps != null && worstSpikeBps >= Math.abs(signed);
  const severity = clamp01(Math.exp(-z / 1.5) + (glitchCouldFlip ? 0.25 : 0));
  return { measured: true, price, threshold, distanceBps: round(signed), yesSideNow: winningSide, typical1mRangeBps: round(typ1m), typicalMoveBps: round(typical), movesAway: round(z, 2), glitchCouldFlip, severity };
}

// Score weights (sum 100). Live evidence = 80 points; history (Walrus precedents, see learn.js) = 20 points.
export const WEIGHTS = { divergence: 20, spikeRevert: 16, distance: 12, repeated: 8, staleness: 8, confidence: 8, thin: 8, history: 20 };

const TEXT = {
  divergence: (f) => `Settlement feed vs ${f.best}: ${fmtBps(f.headlineBps)} ${f.atSettle ? 'at the settlement minute' : 'at its widest'} (after removing the normal basis).`,
  spikeRevert: (f) => (f.worst ? `${f.isolatedCount} spike-and-revert wick(s) with references flat; largest ${f.worst.sizeBps} bps ${f.worst.dir} at ${iso(f.worst.t)}, back within ${f.worst.revertedAfterMin} min.` : `${f.events.length} wick(s) that reverted, but no reference covered those minutes to confirm.`),
  distance: (f) => `Price is ${fmtBps(f.distanceBps)} from the $${f.threshold} line (${f.movesAway} typical moves)${f.glitchCouldFlip ? '; a glitch as big as one already seen would flip it' : ''}.`,
  repeated: (f) => `Same print repeated for ${f.maxRun} straight minutes while the market was open.`,
  staleness: (f) => `Longest gap with no fresh price while open: ${Math.round(f.maxGapSec / 60)} min.`,
  confidence: (f) => `Pyth confidence blew out to ${f.ratio}× its normal width (${f.worstConfBps} bps).`,
  history: (f) => `${f.precedents} precedent(s) in Walrus Memory in this settlement window (−14…+6 min)${f.otherSameFeed ? ` (+${f.otherSameFeed} other incident(s) on this feed)` : ''}.`,
  thin: (f) => (f.settleState ? `Settlement minute falls in ${f.settleState} hours; ` : '') + `${Math.round(f.thinShare * 100)}% of the open window is outside core liquidity.`,
};

/** Weighted Settlement Risk Score 0–100 with reasons, sorted by points. Unmeasured factors are listed, not scored. */
export function score(factors, weights = WEIGHTS) {
  const reasons = [];
  const notMeasured = [];
  let total = 0;
  for (const [k, w] of Object.entries(weights)) {
    const f = factors[k];
    if (!f || !f.measured) { notMeasured.push({ factor: k, note: f?.note || 'no data' }); continue; }
    const pts = w * clamp01(f.severity);
    total += pts;
    if (pts > 0.05) reasons.push({ factor: k, severity: round(f.severity, 2), weight: w, points: round(pts, 1), text: safeText(k, f) });
  }
  reasons.sort((a, b) => b.points - a.points);
  const s = Math.round(Math.min(100, total));
  return { score: s, band: s >= 60 ? 'high' : s >= 30 ? 'elevated' : 'low', reasons, notMeasured };
}

function safeText(k, f) { try { return TEXT[k] ? TEXT[k](f) : k; } catch { return `${k} (severity ${round(f.severity, 2)})`; } }
function quantile(xs, q) { const a = xs.filter(Number.isFinite).sort((x, y) => x - y); if (!a.length) return NaN; return a[Math.min(a.length - 1, Math.floor(q * a.length))]; }
function round(x, d = 1) { if (x == null || !Number.isFinite(x)) return x; const k = 10 ** d; return Math.round(x * k) / k; }
const fmtBps = (x) => (x == null ? 'n/a' : `${x > 0 ? '+' : ''}${x} bps`);
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ') + 'Z';

/** Per-minute divergence series (bps) vs one reference after removing the rolling basis. */
export function divergenceSeries(target, ref, { field = 'close', basisLookback = DEFAULTS.basisLookback } = {}) {
  const pairs = pairsOf(target, byT(ref || []), field);
  const out = [];
  for (let i = 0; i < pairs.length; i++) {
    const lo = Math.max(0, i - basisLookback);
    const prior = pairs.slice(lo, Math.max(lo + 1, i - 2));
    const ratio = median((prior.length >= 5 ? prior : pairs.slice(0, Math.min(pairs.length, 30))).map((x) => x.tc / x.rc));
    out.push({ t: pairs[i].t, bps: bps(pairs[i].tv, pairs[i].rv * ratio), tv: pairs[i].tv, rv: pairs[i].rv, ratio });
  }
  return out;
}

/**
 * Divergence episodes: contiguous minutes with |bps| >= thresholdBps (gaps of up to `joinMinutes` merged).
 * `side` says which price left its own recent path: 'pyth' (settlement feed moved, reference didn't), 'reference', or 'both'.
 */
export function divergenceEpisodes(target, ref, { thresholdBps = 15, joinMinutes = 2, step = 60, ...o } = {}) {
  const s = divergenceSeries(target, ref, o);
  const T = byT(target), R = byT(ref || []);
  const eps = [];
  let cur = null;
  for (const x of s) {
    if (Math.abs(x.bps) >= thresholdBps) {
      if (cur && x.t - cur.end <= joinMinutes * step) { cur.end = x.t; if (Math.abs(x.bps) > Math.abs(cur.peakBps)) Object.assign(cur, { peakBps: x.bps, peakT: x.t }); }
      else { if (cur) eps.push(cur); cur = { start: x.t, end: x.t, peakBps: x.bps, peakT: x.t }; }
    }
  }
  if (cur) eps.push(cur);
  for (const e of eps) {
    e.minutes = Math.round((e.end - e.start) / step) + 1;
    const own = (M, t) => { const prior = []; for (let k = 1; k <= 5; k++) { const c = M.get(t - k * step); if (c) prior.push(c.c); } const c = M.get(t); return c && prior.length ? bps(c.c, median(prior)) : null; };
    const pm = own(T, e.peakT), rm = own(R, e.peakT);
    e.pythMoveBps = round(pm); e.refMoveBps = round(rm); e.peakBps = round(e.peakBps);
    e.side = pm == null || rm == null ? 'unknown' : Math.abs(pm) >= 2 * Math.abs(rm) ? 'pyth' : Math.abs(rm) >= 2 * Math.abs(pm) ? 'reference' : 'both';
  }
  return eps;
}

/** Aggregates 1m candles to N-minute candles aligned to the epoch. */
export function aggregate(candles, minutes = 5) {
  const step = minutes * 60, by = new Map();
  for (const c of candles) {
    const t = Math.floor(c.t / step) * step;
    const a = by.get(t);
    if (!a) by.set(t, { t, o: c.o, h: c.h, l: c.l, c: c.c, n: 1 });
    else { a.h = Math.max(a.h, c.h); a.l = Math.min(a.l, c.l); a.c = c.c; a.n++; }
  }
  return [...by.values()].sort((a, b) => a.t - b.t);
}
