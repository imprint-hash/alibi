// Loads the 90-day calibration (proof/calibration.json, written by src/calibrate.js) and turns it into detector
// params. Rule: every threshold = p99 of real settlement-window minutes (16:54–17:04 ET) for that feed.
// Without a calibration entry the detectors keep the feed-calibrated defaults from check.js calibrate().
import { path, readJson } from './store.js';

export function loadCalibration() { return readJson(path('proof', 'calibration.json'), null); }

/** The thresholds for one instrument, or null. */
export function calibrationFor(instrument, file = loadCalibration()) {
  const t = file?.feeds?.[instrument]?.thresholds;
  if (!t) return null;
  return { ...t, source: 'proof/calibration.json', generatedAt: file.generatedAt ?? null, days: file.days ?? null };
}

/** Merges calibrated thresholds into detector params (pure). Divergence "full" severity is 4× the p99 floor. */
export function applyCalibration(params, cal) {
  if (!cal) return params;
  const p = { ...params };
  if (cal.spikeBps > 0) p.spikeBps = cal.spikeBps;
  if (cal.confRatio > 0) { p.confRatio = cal.confRatio; p.confFullRatio = 3 * cal.confRatio; }
  if (cal.divergenceBps > 0) { p.divergenceFloorBps = cal.divergenceBps; p.divergenceFullBps = Math.max(4 * cal.divergenceBps, cal.divergenceBps + 10); }
  p.calibrated = { source: cal.source, generatedAt: cal.generatedAt, days: cal.days };
  return p;
}

const pct = (x) => (x == null ? 'n/a' : `${Math.round(x * 1000) / 10}%`);
/** Markdown table for the README: each threshold in plain words, naming the population whose p99 set it. Pure. */
export function calibrationTable(file) {
  const rows = ['| feed | signal | Alibi flags at | what it means (90 days of real Pyth data) |', '|---|---|---|---|'];
  for (const [inst, f] of Object.entries(file?.feeds || {})) {
    const t = f.thresholds, s = f.stats, so = t.settlementOnly || {};
    const n = s.minutes.window, b = s.minutes.baseline;
    const from = (k, other) => (t[k] === so[k] ? `1% of the ${n} settlement-window minutes reach it (ordinary minutes: ${other})` : `1% of the ${b} ordinary minutes reach it; settlement-window minutes are calmer (their 1%: ${so[k]})`);
    rows.push(`| ${inst} | confidence band | ≥ ${t.confRatio}× its normal width | ${from('confRatio', `${pct(s.confMultiple.shareOfBaselineAtThreshold)} reach it`)}; the 16:59 candle is typically ${s.confMultiple.settleMedian}× |`);
    rows.push(`| ${inst} | spike | ≥ ${t.spikeBps} bps from the prior 5-min median | ${from('spikeBps', `p99 ${s.excursionBps.baselineP99} bps`)} |`);
    rows.push(`| ${inst} | frozen price | unchanged ≥ ${t.frozenRunSec} s within a minute | ${from('frozenRunSec', `p99 ${s.sameRunSec.baselineP99} s`)}; longest seen ${s.sameRunSec.max} s |`);
    if (t.divergenceBps == null) rows.push(`| ${inst} | divergence vs Hyperliquid | n/a | no Hyperliquid history |`);
    else rows.push(`| ${inst} | divergence vs Hyperliquid | ≥ ${t.divergenceBps} bps after basis | ${t.divergenceBps === so.divergenceBps ? `1% of the ${s.divergence.settlementBars} 5-min bars around settlement reach it (all bars p99 ${Math.round(s.divergence.p99 * 10) / 10} bps)` : `1% of all ${s.divergence.bars5m} 5-min bars reach it (around settlement: ${so.divergenceBps} bps)`}, since ${String(s.divergence.from).slice(0, 10)} |`);
    rows.push(`| ${inst} | print gap | ≥ ${t.staleGapSec} s without a print | never seen: the sampled channel printed every second in all ${n + b} minutes (5 s floor) |`);
  }
  return rows.join('\n');
}
