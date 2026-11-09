import { test } from 'node:test';
import assert from 'node:assert/strict';
import { q, shareAtOrAbove, minuteMetrics, deriveThresholds, strongOutliers } from '../src/calibrate.js';
import { calibrationFor, applyCalibration } from '../src/calibration.js';
import { mistToUsd } from '../src/tatumdata.js';

test('q is nearest-rank; shareAtOrAbove counts the tail', () => {
  const xs = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(q(xs, 0.5), 50);
  assert.equal(q(xs, 0.99), 99);
  assert.equal(q(xs, 1), 100);
  assert.equal(q([], 0.5), null);
  assert.equal(shareAtOrAbove(xs, 99), 0.02);
});

test('minuteMetrics: confidence, frozen run, gap, publishers and excursion from real-shaped prints', () => {
  const t = 6000;
  const prints = [0, 1, 2, 3, 4].map((s) => ({ t: t + s, publishTime: t + s, price: 100, conf: 0.01, publishers: 17 - (s === 4 ? 2 : 0) }));
  prints.push({ t: t + 10, publishTime: t + 10, price: 100.1, conf: 0.03, publishers: 17 });
  const candleMap = new Map([1, 2, 3, 4, 5].map((k) => [t - k * 60, { t: t - k * 60, c: 100 }]));
  candleMap.set(t, { t, h: 100.5, l: 99.9, c: 100.1 });
  const m = minuteMetrics({ t, prints, candleMap });
  assert.equal(m.n, 6);
  assert.equal(m.confBps, 1);
  assert.equal(m.sameRunSec, 4);
  assert.equal(m.maxGapSec, 6);
  assert.equal(m.publishers, 15);
  assert.ok(Math.abs(m.excursionBps - 50) < 0.01);
  assert.equal(m.missingCandle, false);
});

test('deriveThresholds: thresholds are the p99 of settlement-window minutes; plain-share stats included', () => {
  const mk = (confBps, excursionBps, maxGapSec, sameRunSec) => ({ confBps, excursionBps, maxGapSec, sameRunSec });
  const settle = Array.from({ length: 50 }, (_, i) => mk(1 + (i === 49 ? 9 : 0), i / 10, 1, 2));
  const around = Array.from({ length: 50 }, (_, i) => mk(1, i / 5, 1, 3));
  const baseline = Array.from({ length: 100 }, () => mk(0.5, 1, 1, 1));
  const { thresholds, stats } = deriveThresholds({ settle, around, baseline, divergence: { settleP99: 7.25 } });
  assert.equal(thresholds.confRatio, 2); // p99 of (conf / baseline median 0.5) across 100 window minutes
  assert.equal(thresholds.spikeBps, 9.6);
  assert.equal(thresholds.staleGapSec, 5); // floor
  assert.equal(thresholds.divergenceBps, 7.3);
  assert.equal(stats.minutes.window, 100);
  assert.equal(stats.confMultiple.shareOfBaselineAtThreshold, 0);
});

test('strongOutliers keeps only minutes at 2× the threshold, as real-labelled incidents', () => {
  const data = { baseline: [{ confBps: 1 }, { confBps: 1 }], settle: [{ t: 1794000000, confBps: 30, excursionBps: 2 }], around: [{ t: 1794000060, confBps: 5, excursionBps: 50, sameRunSec: 1 }] };
  const out = strongOutliers('Metal.XAU/USD', { instrument: 'XAU' }, data, { confRatio: 10, spikeBps: 20, staleGapSec: 5, frozenRunSec: 10 });
  assert.deepEqual(out.map((o) => o.pattern).sort(), ['confidence', 'spike-revert']);
  assert.ok(out.every((o) => o.simulated === 'no' && o.src === 'calibration-backtest'));
  assert.equal(out.find((o) => o.pattern === 'confidence').ratio, 30);
});

test('calibration file → detector params; missing instrument falls back to feed-calibrated defaults', () => {
  const file = { feeds: { XAU: { thresholds: { confRatio: 12.3, spikeBps: 21.5, divergenceBps: 6.1, staleGapSec: 5, frozenRunSec: 8 } } } };
  const c = calibrationFor('XAU', file);
  assert.equal(c.source, 'proof/calibration.json');
  const p = applyCalibration({ spikeBps: 30, divergenceFloorBps: 10, divergenceFullBps: 60 }, c);
  assert.equal(p.spikeBps, 21.5);
  assert.equal(p.confRatio, 12.3);
  assert.equal(p.divergenceFloorBps, 6.1);
  assert.ok(p.divergenceFullBps > p.divergenceFloorBps);
  const none = calibrationFor('EURUSD', file);
  assert.equal(none, null);
  assert.deepEqual(applyCalibration({ spikeBps: 30 }, null), { spikeBps: 30 });
});

test('mistToUsd converts gas to SUI and dollars', () => {
  assert.deepEqual(mistToUsd('5040603', 0.84258248), { sui: 0.005041, usd: 0.00425 });
  assert.equal(mistToUsd(1e9, NaN).usd, null);
});
