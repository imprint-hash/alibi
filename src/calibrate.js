#!/usr/bin/env node
// 90-day backtest + calibration from REAL Pyth data.
// For each spot feed: every trading day's settlement candle (16:59 ET) ±5 min, plus a random sample of ordinary
// open minutes as a baseline. Prints are sampled on the fixed_rate@1000ms channel (1 call per minute, same
// confidence values as faster channels); 1-minute candles come from the History API (1 call per day).
// Divergence vs Hyperliquid uses 5-minute candles where Hyperliquid keeps them (~17 days).
// Results are cached per feed/day in cache/calib/ so the run can resume. Writes proof/calibration.json.
// Usage: node src/calibrate.js [--days 90] [--baseline 150] [--feeds XAU,XAG,EURUSD]
import { loadEnv } from './env.js';
import * as pyth from './pyth.js';
import { hyperliquidCandles } from './refs.js';
import * as D from './detect.js';
import { parseSchedule, isOpen, zonedToUtc, isoDay, tradingDays } from './sessions.js';
import { PYTH_CODES } from './rules.js';
import { path, readJson, writeJson } from './store.js';

export const PRINT_CHANNEL = 'fixed_rate@1000ms';
export const WINDOW = 5; // ± minutes around the settlement candle

/** Quantile of a numeric array (nearest-rank). */
export function q(xs, p) {
  const a = xs.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1))];
}
/** Share of values >= t. */
export const shareAtOrAbove = (xs, t) => { const a = xs.filter(Number.isFinite); return a.length ? a.filter((x) => x >= t).length / a.length : null; };

/** Per-minute metrics from that minute's prints and the candles around it. Pure. */
export function minuteMetrics({ t, prints, candleMap }) {
  const w = prints.filter((x) => x.t >= t && x.t < t + 60 && x.price > 0 && x.conf != null);
  const m = { t, n: w.length };
  if (w.length) {
    m.confBps = D.median(w.map((x) => (x.conf / x.price) * 1e4));
    const ts = w.map((x) => x.publishTime).sort((a, b) => a - b);
    m.maxGapSec = ts.length > 1 ? Math.max(...ts.slice(1).map((x, i) => x - ts[i])) : null;
    // longest stretch (s) where the published price did not change: frozen-feed signal (fixed-rate channels re-stamp every print)
    let run = 0, best = 0;
    for (let i = 1; i < w.length; i++) { if (w[i].price === w[i - 1].price) { run += w[i].publishTime - w[i - 1].publishTime; best = Math.max(best, run); } else run = 0; }
    m.sameRunSec = Math.round(best * 10) / 10;
    m.publishers = Math.min(...w.map((x) => x.publishers ?? Infinity));
    if (!Number.isFinite(m.publishers)) m.publishers = null;
  }
  const c = candleMap.get(t);
  const prior = [1, 2, 3, 4, 5].map((k) => candleMap.get(t - k * 60)).filter(Boolean).map((x) => x.c);
  if (c && prior.length >= 3) {
    const base = D.median(prior);
    m.excursionBps = Math.max(Math.abs(D.bps(c.h, base)), Math.abs(D.bps(c.l, base)));
    m.rangeBps = D.bps(c.h, c.l);
  }
  m.missingCandle = !c;
  return m;
}

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

async function runFeed(sym, map, days, baselineN, log) {
  const feed = pyth.feedBySymbol(await pyth.symbols(), sym);
  const sched = parseSchedule(feed.schedule);
  const now = Math.floor(Date.now() / 1000);
  const first = isoDay((now - days * 86400) * 1000, 'America/New_York');
  const last = isoDay((now - 86400) * 1000, 'America/New_York');
  const daysList = tradingDays(sched, first, last);
  const settle = [], around = [], baseline = [], failedDays = [];
  const rand = rng(feed.lazerId * 7919);
  const perDayBaseline = Math.max(1, Math.round(baselineN / daysList.length));
  for (const day of daysList) {
    const cacheFile = path('cache', 'calib', `${map.instrument}-${day}.json`);
    let rec = readJson(cacheFile, null);
    if (!rec) try {
      const [y, mo, d] = day.split('-').map(Number);
      const cc = zonedToUtc(y, mo, d, 16, 59, 'America/New_York') / 1000;
      if (!isOpen(sched, cc * 1000)) { writeJson(cacheFile, { day, skipped: 'no 16:59 ET candle (early close)' }); continue; }
      const cs = await pyth.candles(sym, cc - 26 * 3600, cc + 120, '1', feed.channel);
      const cm = new Map(cs.map((c) => [c.t, c]));
      const mins = [];
      for (let k = -WINDOW; k <= WINDOW; k++) if (isOpen(sched, (cc + k * 60) * 1000)) mins.push(cc + k * 60);
      const base = [];
      const openMins = cs.filter((c) => c.t < cc - 30 * 60 && isOpen(sched, c.t * 1000)).map((c) => c.t);
      for (let i = 0; i < perDayBaseline && openMins.length; i++) base.push(openMins[Math.floor(rand() * openMins.length)]);
      const out = { day, cc, settle: [], baseline: [] };
      for (const t of mins) { const p = await pyth.printsRange(feed.lazerId, t, t + 59, PRINT_CHANNEL); out.settle.push({ k: (t - cc) / 60, ...minuteMetrics({ t, prints: p, candleMap: cm }) }); }
      for (const t of base) { const p = await pyth.printsRange(feed.lazerId, t, t + 59, PRINT_CHANNEL); out.baseline.push(minuteMetrics({ t, prints: p, candleMap: cm })); }
      writeJson(cacheFile, out);
      rec = out;
      log(`${map.instrument} ${day}: ${out.settle.length} settlement-window + ${out.baseline.length} baseline minutes`);
    } catch (e) { log(`${map.instrument} ${day}: skipped this run (${String(e.message).slice(0, 80)}); rerun to fill`); failedDays.push(day); continue; }
    if (rec.skipped) continue;
    for (const m of rec.settle) (m.k === 0 ? settle : around).push({ ...m, day });
    baseline.push(...rec.baseline.map((m) => ({ ...m, day })));
  }
  // Divergence vs Hyperliquid (5m, where kept): Pyth 1m → 5m around each settlement minute that HL covers.
  let divergence = { note: 'not available' };
  try {
    const hl5 = await hyperliquidCandles(map.hlCoin, now - days * 86400, now, '5m');
    if (hl5.length) {
      const from = hl5[0].t;
      const pc = await pyth.candles(sym, from, now, '1', feed.channel);
      const series = D.divergenceSeries(D.aggregate(pc, 5), hl5).map((x) => ({ t: x.t, abs: Math.abs(x.bps) }));
      const ccSet = new Set([...settle, ...around].map((m) => Math.floor(m.t / 300) * 300));
      const atSettle = series.filter((x) => ccSet.has(x.t)).map((x) => x.abs);
      const all = series.map((x) => x.abs);
      divergence = { from: new Date(from * 1000).toISOString(), bars5m: all.length, settlementBars: atSettle.length, p50: q(all, 0.5), p99: q(all, 0.99), settleP99: q(atSettle, 0.99), settleMax: q(atSettle, 1) };
    }
  } catch (e) { divergence = { note: `error: ${String(e.message).slice(0, 100)}` }; }
  return { feed, daysList, settle, around, baseline, divergence, failedDays };
}

/** Thresholds from percentiles. Pure. "flag ≥ p99 of settlement-window minutes". */
export function deriveThresholds({ settle, around, baseline, divergence }) {
  const win = [...settle, ...around];
  const baseConf = D.median(baseline.map((m) => m.confBps));
  const mult = (xs) => xs.map((m) => (baseConf > 0 && Number.isFinite(m.confBps) ? m.confBps / baseConf : NaN));
  const winMult = mult(win), baseMult = mult(baseline), settleMult = mult(settle);
  const exc = win.map((m) => m.excursionBps);
  const gaps = win.map((m) => m.maxGapSec);
  const runs = win.map((m) => m.sameRunSec);
  const t = {
    confRatio: round(q(winMult, 0.99), 2),
    spikeBps: round(q(exc, 0.99), 1),
    staleGapSec: round(Math.max(5, q(gaps, 0.99) ?? 5), 1),
    frozenRunSec: round(q(runs, 0.99), 1),
    divergenceBps: divergence?.settleP99 != null ? round(divergence.settleP99, 1) : null,
  };
  const stats = {
    minutes: { settlement: settle.length, window: win.length, baseline: baseline.length },
    baselineMedianConfBps: round(baseConf, 3),
    confMultiple: { settleMedian: round(q(settleMult, 0.5), 2), windowP90: round(q(winMult, 0.9), 2), windowP99: t.confRatio, baselineP99: round(q(baseMult, 0.99), 2), shareOfBaselineAtThreshold: round(shareAtOrAbove(baseMult, t.confRatio), 4) },
    excursionBps: { windowP50: round(q(exc, 0.5), 1), windowP99: t.spikeBps, baselineP99: round(q(baseline.map((m) => m.excursionBps), 0.99), 1), max: round(q(exc, 1), 1) },
    maxPrintGapSec: { windowP50: round(q(gaps, 0.5), 2), windowP99: round(q(gaps, 0.99), 2), max: round(q(gaps, 1), 2) },
    sameRunSec: { windowP50: round(q(runs, 0.5), 1), windowP99: round(q(runs, 0.99), 1), baselineP99: round(q(baseline.map((m) => m.sameRunSec), 0.99), 1), max: round(q(runs, 1), 1) },
    missingSettlementCandles: settle.filter((m) => m.missingCandle).length,
    divergence,
  };
  return { thresholds: t, stats };
}
const round = (x, d) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

/** Real outliers worth remembering: settlement-window minutes beyond 2× the p99 threshold (strong-only). Pure. */
export function strongOutliers(sym, map, data, thr) {
  const baseConf = D.median(data.baseline.map((m) => m.confBps));
  const out = [];
  for (const m of [...data.settle, ...data.around]) {
    const mult = baseConf > 0 ? m.confBps / baseConf : NaN;
    const when = new Date(m.t * 1000).toISOString().slice(0, 16) + ':00Z';
    const base = { instrument: map.instrument, feed: sym, simulated: 'no', when, bucket: 'session-close', res: '1m', src: 'calibration-backtest' };
    if (Number.isFinite(mult) && thr.confRatio && mult >= 2 * thr.confRatio) out.push({ ...base, pattern: 'confidence', ratio: round(mult, 1), conf_bps: round(m.confBps, 2), publishers: m.publishers, severity: round(mult / thr.confRatio, 2), threshold: `p99=${thr.confRatio}x` });
    if (Number.isFinite(m.excursionBps) && thr.spikeBps && m.excursionBps >= 2 * thr.spikeBps) out.push({ ...base, pattern: 'spike-revert', size_bps: round(m.excursionBps, 1), severity: round(m.excursionBps / thr.spikeBps, 2), threshold: `p99=${thr.spikeBps}bps`, note: 'excursion vs prior-5 median; revert not checked' });
    if (Number.isFinite(m.sameRunSec) && thr.frozenRunSec && m.sameRunSec >= Math.max(20, 2 * thr.frozenRunSec)) out.push({ ...base, pattern: 'repeated', minutes: round(m.sameRunSec / 60, 2), run_sec: m.sameRunSec, severity: round(m.sameRunSec / thr.frozenRunSec, 2), threshold: `p99=${thr.frozenRunSec}s` });
    if (Number.isFinite(m.maxGapSec) && m.maxGapSec >= Math.max(30, 2 * thr.staleGapSec)) out.push({ ...base, pattern: 'stale', gap_min: round(m.maxGapSec / 60, 2), severity: round(m.maxGapSec / thr.staleGapSec, 2), threshold: `p99=${thr.staleGapSec}s` });
  }
  return out.sort((a, b) => b.severity - a.severity);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  loadEnv();
  const args = process.argv.slice(2);
  const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  const days = Number(opt('--days', 90));
  const baselineN = Number(opt('--baseline', 150));
  const feeds = opt('--feeds', 'XAU,XAG,EURUSD').split(',');
  const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
  const result = { generatedAt: new Date().toISOString(), days, window: `16:59 ET ±${WINDOW} min`, printChannel: PRINT_CHANNEL, rule: 'threshold = p99 of settlement-window minutes (16:54–17:04 ET); flag at or above it', feeds: {}, outliers: [] };
  for (const [sym, map] of Object.entries(PYTH_CODES).filter(([, m]) => m.spot && feeds.includes(m.instrument))) {
    const data = await runFeed(sym, map, days, baselineN, log);
    const { thresholds, stats } = deriveThresholds(data);
    result.feeds[map.instrument] = { symbol: sym, tradingDays: data.daysList.length, daysMissing: data.failedDays, thresholds, stats };
    result.outliers.push(...strongOutliers(sym, map, data, thresholds));
    log(`${map.instrument}: ${JSON.stringify(thresholds)}`);
  }
  writeJson(path('proof', 'calibration.json'), result);
  console.log(JSON.stringify(result, null, 2));
}
