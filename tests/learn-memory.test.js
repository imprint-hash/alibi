import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemWalMock } from '@mysten-incubation/memwal';
import * as mem from '../src/memory.js';
import { applyMemories, classify, historyFactor, describePrecedent, etMinute, incidentsFrom, HISTORY } from '../src/learn.js';

// Gold market settling on the 16:59 ET candle (21:59Z in November).
const NOW = Date.parse('2026-11-09T12:00:00Z');
const ctx = { instrument: 'XAU', feed: 'Metal.XAU/USD', settleMinuteET: 16 * 60 + 59 };
const liveFactors = () => ({
  divergence: { measured: true, severity: 0, best: 'Hyperliquid xyz:GOLD', headlineBps: 3, atSettle: false },
  spikeRevert: { measured: true, severity: 0, events: [], isolatedCount: 0, worst: null },
  confidence: { measured: true, severity: 0.68, ratio: 7.1, worstConfBps: 3.3 },
  thin: { measured: true, severity: 0.82, settleState: 'thin', thinShare: 0.54 },
});
const inc = (o = {}) => mem.encode('incident', { instrument: 'XAU', feed: 'Metal.XAU/USD', simulated: 'no', pattern: 'confidence', ratio: 23.5, conf_bps: 12.8, when: '2026-11-06T21:55:00Z', severity: '5.88', ...o });
const m = (blobId, text) => ({ blobId, text, record: mem.decode(text) });

test('encode/decode round trip and sanitising', () => {
  const t = mem.encode('incident', { a: 'x|y', b: 'line\nbreak', c: null });
  assert.equal(t, 'ALIBI-INCIDENT v1 | a=x y | b=line break');
  assert.deepEqual(mem.decode(t), { kind: 'incident', a: 'x y', b: 'line break' });
  assert.equal(mem.decode('random text'), null);
});

test('etMinute converts to New York time', () => {
  assert.equal(etMinute(Date.parse('2026-11-06T21:55:00Z')), 16 * 60 + 55);
});

test('classify: same feed + settlement window = precedent; other times = same-feed other; other feeds ignored', () => {
  const c = classify([
    m('pre1', inc()),
    m('other1', inc({ when: '2026-11-05T16:00:00Z', ratio: 7.6, severity: '1.9' })),
    m('xag', inc({ instrument: 'XAG', feed: 'Metal.XAG/USD' })),
    m('src', mem.encode('source', { instrument: 'XAU', feed: 'Metal.XAU/USD', fact: 'calibration' })),
    m('junk', 'hello'),
  ], ctx, NOW);
  assert.deepEqual(c.sameWindow.map((p) => p.blobId), ['pre1']);
  assert.equal(c.sameWindow[0].offsetMin, 4);
  assert.deepEqual(c.sameFeedOther.map((p) => p.blobId), ['other1']);
  assert.deepEqual(c.ignored.map((i) => i.blobId).sort(), ['junk', 'src', 'xag']);
  assert.match(c.ignored.find((i) => i.blobId === 'xag').reason, /different feed/);
});

test('describePrecedent writes one plain line with date and offset to the reference candle', () => {
  assert.equal(describePrecedent(mem.decode(inc()), 4), "6 Nov: confidence 23.5× normal (12.8 bps), 4 min before this market's reference candle");
  assert.match(describePrecedent(mem.decode(inc({ pattern: 'spike-revert', size_bps: 56.9, dir: 'down', reverted_min: 5, ref_move_bps: 18.1 })), null), /56.9 bps spike-and-revert/);
  assert.match(describePrecedent(mem.decode(inc()), 0), /on this market's reference candle/);
});

test('history factor: weighted by severity and recency, saturating; window precedents count far more', () => {
  const one = historyFactor(classify([m('a', inc())], ctx, NOW));
  const four = historyFactor(classify([m('a', inc()), m('b', inc({ when: '2026-11-04T21:59:00Z' })), m('c', inc({ when: '2026-11-03T21:57:00Z' })), m('d', inc({ when: '2026-11-02T21:58:00Z' }))], ctx, NOW));
  const offWindow = historyFactor(classify([m('a', inc({ when: '2026-11-06T14:00:00Z' }))], ctx, NOW));
  const old = historyFactor(classify([m('a', inc({ when: '2026-08-01T21:55:00Z' }))], ctx, NOW));
  const weak = historyFactor(classify([m('a', inc({ severity: '1.0' }))], ctx, NOW));
  assert.ok(one.severity > 0.5 && one.severity < 0.7, `one ${one.severity}`);
  assert.ok(four.severity > one.severity && four.severity <= 1);
  assert.ok(offWindow.severity < one.severity * HISTORY.otherTimeWeight * 1.5);
  assert.ok(old.severity < one.severity);
  assert.ok(weak.severity < one.severity);
  const sim = historyFactor(classify([m('a', inc({ simulated: 'yes' }))], ctx, NOW));
  assert.ok(sim.severity < one.severity);
  assert.equal(historyFactor(classify([], ctx, NOW), { memorySearched: false }).measured, false);
});

test('applyMemories: precedent adds its own history points, names the blob, live factors untouched', () => {
  const f = liveFactors();
  const out = applyMemories(f, [m('d08odBwCOEO2', inc())], ctx, { nowMs: NOW });
  const hist = out.after.reasons.find((r) => r.factor === 'history');
  assert.ok(hist && hist.points >= 10, `history points ${hist?.points}`);
  assert.ok(Math.abs(out.after.score - out.before.score - hist.points) <= 1, 'score change equals the history points (rounding)');
  assert.ok(out.after.score >= out.before.score + 10);
  assert.equal(out.precedents[0].blobId, 'd08odBwCOEO2');
  assert.match(out.explanation, /1 precedent at this exact settlement window \(d08odBwC…\)/);
  assert.equal(f.confidence.severity, 0.68, 'live factors not mutated');
  assert.equal(out.after.reasons.find((r) => r.factor === 'confidence').points, out.before.reasons.find((r) => r.factor === 'confidence').points);
});

test('memories for other feeds never move the score', () => {
  const out = applyMemories(liveFactors(), [m('xag', inc({ instrument: 'XAG', feed: 'Metal.XAG/USD' })), m('eur', inc({ instrument: 'EURUSD', feed: 'FX.EUR/USD' }))], ctx, { nowMs: NOW });
  assert.equal(out.after.score, out.before.score);
  assert.equal(out.ignored.length, 2);
  assert.match(out.explanation, /live data only/);
});

test('benign user verdict lowers the matching live factor and halves the history factor', () => {
  const verdict = mem.encode('verdict', { instrument: 'XAU', feed: 'Metal.XAU/USD', pattern: 'confidence', verdict: 'benign', when: '2026-11-08T00:00:00Z', reason: 'publisher maintenance' });
  const withV = applyMemories(liveFactors(), [m('a', inc()), m('v', verdict)], ctx, { nowMs: NOW });
  const without = applyMemories(liveFactors(), [m('a', inc())], ctx, { nowMs: NOW });
  assert.ok(withV.after.score < without.after.score);
  assert.ok(withV.changes.some((c) => c.factor === 'confidence' && c.points < 0));
  assert.ok(withV.history.severity < without.history.severity);
});

test('memory not searched → history unmeasured, listed in notMeasured, score unchanged', () => {
  const out = applyMemories(liveFactors(), [], ctx, { nowMs: NOW, memorySearched: false });
  assert.equal(out.before.score, out.after.score);
  assert.ok(out.after.notMeasured.some((n) => n.factor === 'history'));
});

test('incidentsFrom only reports what the detectors actually found', () => {
  const f = { spikeRevert: { events: [{ t: 1794000000, dir: 'up', sizeBps: 80, isolated: true, ref: 'r', refMoveBps: 3, revertedAfterMin: 1 }, { t: 1794000060, dir: 'down', sizeBps: 50, isolated: false }] }, divergence: { measured: true, severity: 0.1, perRef: [] } };
  const out = incidentsFrom(f, { ...ctx, bucketAt: () => 'session-close' });
  assert.equal(out.length, 1);
  assert.equal(out[0].pattern, 'spike-revert');
  assert.equal(out[0].simulated, 'no');
});

test('remember → recall → history loop through the offline MemWalMock (labelled mock, not Walrus)', async () => {
  mem.setClient(MemWalMock.create({ namespace: mem.NS.incidents }), 'mock');
  const w = await mem.remember(mem.NS.incidents, 'incident', (({ kind, ...r }) => r)(mem.decode(inc())));
  assert.equal(w.backend, 'mock');
  const got = await mem.recall(mem.NS.incidents, 'ALIBI incident XAU confidence');
  assert.ok(got.length >= 1);
  const out = applyMemories(liveFactors(), got, ctx, { nowMs: NOW });
  assert.equal(out.precedents.length, 1);
  assert.ok(out.after.score > out.before.score);
});

test('remember passes the namespace as the 2nd (string) argument, which the SDK honours', async () => {
  const calls = [];
  mem.setClient({ rememberAndWait: async (text, ns, opts) => { calls.push({ ns, opts }); return { blob_id: 'b', namespace: ns }; } }, 'spy');
  await mem.remember(mem.NS.sources, 'source', { instrument: 'XAU', fact: 'x' });
  assert.equal(calls[0].ns, 'alibi-sources');
  assert.equal(calls[0].opts.dedupe, true);
});
