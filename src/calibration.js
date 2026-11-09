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
/** Markdown table for the README: each threshold in plain words. Pure. */
export function calibrationTable(file) {
  const rows = ['| feed | threshold | value | what it means |', '|---|---|---|---|'];
  for (const [inst, f] of Object.entries(file?.feeds || {})) {
    const t = f.thresholds, s = f.stats;
    const n = s.minutes.window;
    rows.push(`| ${inst} | confidence multiple | ≥ ${t.confRatio}× the normal band | reached on 1% of the ${n} settlement-window minutes (16:54–17:04 ET, ${f.tradingDays} trading days); ${pct(s.confMultiple.shareOfBaselineAtThreshold)} of ordinary minutes; median at the 16:59 candle is ${s.confMultiple.settleMedian}× |`);
    rows.push(`| ${inst} | spike size | ≥ ${t.spikeBps} bps away from the prior 5-minute median | reached on 1% of settlement-window minutes (ordinary minutes: p99 ${s.excursionBps.baselineP99} bps) |`);
    rows.push(`| ${inst} | frozen price | price unchanged for ≥ ${t.frozenRunSec} s inside a minute | reached on 1% of settlement-window minutes (ordinary p99 ${s.sameRunSec.baselineP99} s) |`);
    rows.push(`| ${inst} | print gap | no print for ≥ ${t.staleGapSec} s | p99 of settlement-window minutes is ${s.maxPrintGapSec.windowP99} s; 5 s floor (the 1 s channel always prints) |`);
    rows.push(`| ${inst} | divergence vs Hyperliquid | ≥ ${t.divergenceBps ?? 'n/a'} bps after basis | ${t.divergenceBps == null ? 'no Hyperliquid history' : `reached on 1% of 5-min bars around settlement since ${String(s.divergence.from).slice(0, 10)} (all bars p99 ${Math.round(s.divergence.p99 * 10) / 10} bps)`} |`);
  }
  return rows.join('\n');
}
