import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../src/detect.js';

// Synthetic 1m series helpers. t in seconds, start at an arbitrary minute.
const T0 = 1794000000 - (1794000000 % 60);
function flatSeries(n, price = 90, noise = 0.0002) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = price * (1 + noise * Math.sin(i / 3));
    out.push({ t: T0 + i * 60, o: p, h: p * 1.0001, l: p * 0.9999, c: p });
  }
  return out;
}
const scale = (cs, k) => cs.map((c) => ({ t: c.t, o: c.o * k, h: c.h * k, l: c.l * k, c: c.c * k }));

test('divergence: zero after basis removal when target = ref × constant', () => {
  const ref = flatSeries(200);
  const target = scale(ref, 1.01); // 100 bps constant basis
  const r = D.divergence(target, [{ name: 'ref', candles: ref, independent: true }]);
  assert.ok(r.measured);
  assert.ok(Math.abs(r.headlineBps) < 1, `got ${r.headlineBps}`);
  assert.equal(r.severity, 0);
});

test('divergence: detects a one-sided move in bps for the same field and minute', () => {
  const ref = flatSeries(200);
  const target = scale(ref, 1.01);
  target[150] = { ...target[150], c: target[150].c * 1.01 }; // +100 bps on the close
  const r = D.divergence(target, [{ name: 'ref', candles: ref, independent: true }], { field: 'close' });
  assert.ok(Math.abs(r.headlineBps - 100) < 3, `got ${r.headlineBps}`);
  assert.ok(r.severity > 0.5);
  const atSettle = D.divergence(target, [{ name: 'ref', candles: ref }], { field: 'close', settleT: target[150].t });
  assert.equal(atSettle.atSettle, true);
  assert.ok(Math.abs(atSettle.headlineBps - 100) < 3);
});

test('divergence: picks the reference that agrees best, so one noisy ref cannot fake an alarm', () => {
  const ref = flatSeries(200);
  const noisy = ref.map((c, i) => (i % 7 === 0 ? { ...c, c: c.c * 1.02 } : c));
  const r = D.divergence(ref, [{ name: 'noisy', candles: noisy }, { name: 'good', candles: ref }]);
  assert.equal(r.best, 'good');
  assert.ok(Math.abs(r.headlineBps) < 1);
});

test('spikeRevert: flags a wick that reverts within N minutes while refs stay flat', () => {
  const ref = flatSeries(60);
  const target = flatSeries(60);
  const i = 30;
  target[i] = { ...target[i], h: target[i].c * 1.008, c: target[i].c }; // 80 bps wick, closes back
  const r = D.spikeRevert(target, [{ name: 'ref', candles: ref }], { spikeBps: 40, revertMinutes: 5 });
  assert.equal(r.isolatedCount, 1);
  assert.equal(r.worst.dir, 'up');
  assert.ok(r.worst.sizeBps >= 75 && r.worst.sizeBps <= 85, `size ${r.worst.sizeBps}`);
  assert.equal(r.worst.revertedAfterMin, 0);
  assert.ok(r.severity >= 0.4);
});

test('spikeRevert: not isolated when the reference moves too', () => {
  const ref = flatSeries(60);
  const target = flatSeries(60);
  target[30] = { ...target[30], h: target[30].c * 1.008 };
  ref[30] = { ...ref[30], h: ref[30].c * 1.007 };
  const r = D.spikeRevert(target, [{ name: 'ref', candles: ref }]);
  assert.equal(r.isolatedCount, 0);
  assert.equal(r.events[0].isolated, false);
});

test('spikeRevert: a move that does not come back is not a spike-and-revert', () => {
  const target = flatSeries(60);
  for (let i = 30; i < 60; i++) target[i] = scale([target[i]], 1.01)[0];
  const r = D.spikeRevert(target, [{ name: 'ref', candles: flatSeries(60) }]);
  assert.equal(r.events.length, 0);
});

test('repeatedPrints: finds identical flat prints while open, ignores closed hours', () => {
  const s = flatSeries(40);
  for (let i = 10; i < 22; i++) s[i] = { t: s[i].t, o: 91, h: 91, l: 91, c: 91 };
  const open = D.repeatedPrints(s, () => 'core', { repeatMinRun: 5 });
  assert.equal(open.maxRun, 12);
  assert.ok(open.severity > 0);
  const closed = D.repeatedPrints(s, () => 'closed');
  assert.equal(closed.maxRun, 0);
});

test('staleness: missing minutes while open and publish-time gaps', () => {
  const s = flatSeries(60).filter((_, i) => i < 20 || i >= 35); // 15-minute hole
  const r = D.staleness(s, [], () => 'core', { from: T0, to: T0 + 59 * 60 });
  assert.equal(r.maxGapSec, 15 * 60);
  assert.ok(r.severity > 0.2);
  const closedHole = D.staleness(s, [], (t) => (t >= T0 + 20 * 60 && t < T0 + 35 * 60 ? 'closed' : 'core'), { from: T0, to: T0 + 59 * 60 });
  assert.equal(closedHole.maxGapSec, 0);
  const prints = [{ t: T0, publishTime: T0, price: 90, conf: 0.01 }, { t: T0 + 600, publishTime: T0 + 600, price: 90, conf: 0.01 }];
  const pr = D.staleness([], prints, () => 'core');
  assert.equal(pr.gaps[0].kind, 'publish-gap');
  assert.equal(pr.maxGapSec, 600);
});

test('confidenceBlowout: ratio vs own median; unmeasured without prints', () => {
  assert.equal(D.confidenceBlowout([]).measured, false);
  const prints = Array.from({ length: 50 }, (_, i) => ({ t: T0 + i, price: 90, conf: i === 40 ? 0.9 : 0.09 }));
  const r = D.confidenceBlowout(prints);
  assert.equal(r.ratio, 10);
  assert.equal(r.events.length, 1);
  assert.ok(r.severity > 0.5);
});

test('thinHours: settlement minute in thin hours scores higher than in core', () => {
  const minutes = Array.from({ length: 100 }, (_, i) => T0 + i * 60);
  const liq = (t) => (t < T0 + 70 * 60 ? 'core' : 'thin');
  const thin = D.thinHours(minutes, liq, T0 + 99 * 60);
  const core = D.thinHours(minutes, liq, T0 + 10 * 60);
  assert.equal(thin.settleState, 'thin');
  assert.equal(core.settleState, 'core');
  assert.ok(thin.severity > core.severity);
  assert.equal(thin.thinShare, 0.3);
  assert.equal(D.thinHours(minutes, liq, null).settleState, null);
});

test('thresholdDistance: near the line is risky; a seen glitch that could flip it adds risk', () => {
  const cs = flatSeries(100, 94);
  const near = D.thresholdDistance({ price: 94.05, threshold: 94, comparator: '>', candles: cs, minutesLeft: 1 });
  const far = D.thresholdDistance({ price: 99, threshold: 94, comparator: '>', candles: cs, minutesLeft: 1 });
  assert.ok(near.severity > far.severity);
  assert.equal(near.yesSideNow, true);
  assert.ok(Math.abs(near.distanceBps - 5.3) < 0.2);
  const flip = D.thresholdDistance({ price: 94.3, threshold: 94, candles: cs, minutesLeft: 1, worstSpikeBps: 80 });
  assert.equal(flip.glitchCouldFlip, true);
  const below = D.thresholdDistance({ price: 93, threshold: 94, comparator: '>', candles: cs });
  assert.equal(below.yesSideNow, false);
});

test('score: 0–100, weighted reasons sorted, unmeasured listed not scored', () => {
  const s = D.score({
    divergence: { measured: true, severity: 1, best: 'r', headlineBps: 200, atSettle: true },
    spikeRevert: { measured: true, severity: 0.5, isolatedCount: 1, events: [], worst: { sizeBps: 60, dir: 'up', t: T0, revertedAfterMin: 2 } },
    thin: { measured: true, severity: 0.6, settleState: 'thin', thinShare: 0 },
    confidence: { measured: false, severity: 0, note: 'needs prints' },
  });
  assert.equal(s.score, 33); // 20 + 8 + 4.8 (weights: divergence 20, spikeRevert 16, thin 8)
  assert.equal(s.band, 'elevated');
  assert.deepEqual(s.reasons.map((r) => r.factor), ['divergence', 'spikeRevert', 'thin']);
  assert.ok(s.notMeasured.some((n) => n.factor === 'confidence'));
  assert.equal(Object.values(D.WEIGHTS).reduce((a, b) => a + b, 0), 100);
  assert.equal(D.WEIGHTS.history, 20);
  const all = Object.fromEntries(Object.keys(D.WEIGHTS).map((k) => [k, { measured: true, severity: 1 }]));
  assert.equal(D.score(all).score, 100);
});
