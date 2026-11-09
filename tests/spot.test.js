import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as S from '../src/sessions.js';
import * as P from '../src/pyth.js';
import * as D from '../src/detect.js';
import { parseRulesDeterministic, validateAiSpec } from '../src/rules.js';
import { closeCandleT, priorReferenceDay, settlementPlan, calibrate } from '../src/check.js';
import { priceIdentifierBcs } from '../src/sui.js';

const M = JSON.parse(readFileSync(new URL('./fixtures/markets.json', import.meta.url)));
const SYM = JSON.parse(readFileSync(new URL('./fixtures/pyth-spot-symbols.json', import.meta.url)));
const xau = P.feedBySymbol(SYM, 'Metal.XAU/USD');
const eur = P.feedBySymbol(SYM, 'FX.EUR/USD');
const iso = (s) => new Date(s * 1000).toISOString();

test('gold up/down rules: Pyth spot symbol from the pythdata.app link, 4:59 PM ET close candle, CME fallback', () => {
  const s = parseRulesDeterministic(M['xauusd-up-or-down-on-november-9-2026']);
  assert.equal(s.source, 'pyth');
  assert.equal(s.pythCode, 'Metal.XAU/USD');
  assert.equal(s.instrument, 'XAU');
  assert.equal(s.monthRule, 'spot');
  assert.equal(s.kind, 'close-vs-prior-close');
  assert.equal(s.closeCandleET, '16:59');
  assert.equal(s.tieRule, '50-50');
  assert.match(s.fallbackSource, /COMEX Gold/);
});

test('gold weekly hit, silver and EUR/USD templates parse', () => {
  const h = parseRulesDeterministic(M['will-xauusd-reach-4400-by-november-9-2026']);
  assert.deepEqual([h.kind, h.field, h.comparator, h.threshold, h.window.type], ['hit-high', 'high', '>=', 4400, 'week']);
  assert.equal(parseRulesDeterministic(M['xagusd-up-or-down-on-november-9-2026']).pythCode, 'Metal.XAG/USD');
  const e = parseRulesDeterministic(M['eurusd-up-or-down-on-november-9-2026']);
  assert.deepEqual([e.pythCode, e.kind, e.closeCandleET, e.tieRule], ['FX.EUR/USD', 'close-vs-prior-close', '16:59', '50-50']);
});

test('AI pythCode check accepts the decoded symbol from an URL-encoded link', () => {
  const { ok } = validateAiSpec({ source: 'pyth', pythCode: 'Metal.XAU/USD', field: 'close', kind: 'close-vs-prior-close', comparator: '>', monthRule: 'spot', edgeCases: [] }, M['xauusd-up-or-down-on-november-9-2026']);
  assert.equal(ok.pythCode, 'Metal.XAU/USD');
});

test('metal sessions: 18:00 ET Sunday → 17:00 ET; Sunday itself is not a trading day', () => {
  const sc = S.parseSchedule(xau.schedule);
  const mon = S.sessionForDay(sc, '2026-11-09');
  assert.equal(new Date(mon.open).toISOString(), '2026-11-08T23:00:00.000Z');
  assert.equal(new Date(mon.close).toISOString(), '2026-11-09T22:00:00.000Z');
  assert.equal(S.sessionForDay(sc, '2026-11-08'), null);
  assert.equal(S.sessionForDay(sc, '2026-11-07'), null);
});

test('FX: weekdays open around the clock are sessions; Friday does not merge back into earlier days', () => {
  const sc = S.parseSchedule(eur.schedule);
  assert.equal(S.sessionForDay(sc, '2026-11-09').continuous, true);
  const fri = S.sessionForDay(sc, '2026-11-06');
  assert.equal(new Date(fri.close).toISOString(), '2026-11-06T22:00:00.000Z');
  assert.ok(fri.close - fri.open <= 86400000);
});

test('close candle is 16:59 ET and the prior reference day for Monday is Friday', () => {
  const spec = { closeCandleET: '16:59' };
  assert.equal(iso(closeCandleT(spec, '2026-11-09')), '2026-11-09T21:59:00.000Z');
  assert.equal(iso(closeCandleT(spec, '2026-07-01')), '2026-07-01T20:59:00.000Z'); // EDT
  const sc = S.parseSchedule(xau.schedule);
  assert.equal(priorReferenceDay(spec, sc, '2026-11-09'), '2026-11-06');
  assert.equal(priorReferenceDay(spec, sc, '2026-11-10'), '2026-11-09');
});

test('settlement plan for a spot market has one feed, no roll, and the rule close candle', () => {
  const spec = parseRulesDeterministic(M['xauusd-up-or-down-on-november-9-2026']);
  const plan = settlementPlan(spec, [xau], {}, Date.parse('2026-11-09T07:00:00Z') / 1000);
  assert.equal(plan.sessions.length, 1);
  assert.equal(plan.sessions[0].contract.symbol, 'Metal.XAU/USD');
  assert.equal(iso(plan.sessions[0].settleT), '2026-11-09T21:59:00.000Z');
  assert.equal(plan.started, true);
  assert.equal(plan.notes.length, 0);
  const wk = settlementPlan(parseRulesDeterministic(M['will-xauusd-reach-4400-by-november-9-2026']), [xau], {}, Date.parse('2026-11-09T07:00:00Z') / 1000);
  assert.equal(wk.sessions.length, 5);
});

test('feed channel comes from Pyth metadata (gold is not on real_time)', () => {
  assert.equal(xau.channel, 'fixed_rate@200ms');
  assert.equal(xau.lazerId, 346);
  assert.equal(priceIdentifierBcs(xau.hermesId).length, 33);
});

const T0 = 1794000000 - (1794000000 % 60);
const series = (n, p = 4000) => Array.from({ length: n }, (_, i) => ({ t: T0 + i * 60, o: p, h: p * 1.0002, l: p * 0.9998, c: p * (1 + 0.0001 * Math.sin(i)) }));

test('divergenceEpisodes: finds one episode, joins near minutes, says which side moved', () => {
  const ref = series(200);
  const tgt = series(200).map((c) => ({ ...c }));
  for (const i of [120, 121, 123]) tgt[i] = { ...tgt[i], c: tgt[i].c * 1.003 };
  const eps = D.divergenceEpisodes(tgt, ref, { thresholdBps: 15 });
  assert.equal(eps.length, 1);
  assert.equal(eps[0].start, tgt[120].t);
  assert.equal(eps[0].end, tgt[123].t);
  assert.equal(eps[0].side, 'pyth');
  assert.ok(eps[0].peakBps > 25);
  const refSide = D.divergenceEpisodes(ref, tgt, { thresholdBps: 15 });
  assert.equal(refSide[0].side, 'reference');
});

test('aggregate builds 5-minute candles', () => {
  const a = D.aggregate(series(10), 5);
  assert.ok(a.length >= 2 && a.length <= 3);
  assert.equal(a.reduce((n, c) => n + c.n, 0), 10);
});

test('calibrate scales thresholds to the feed and keeps floors', () => {
  const p = calibrate(series(100).map((c) => ({ ...c, h: c.c * 1.00001, l: c.c * 0.99999 })));
  assert.equal(p.spikeBps, 15); // floor: tiny ranges
  const wide = calibrate(series(100).map((c) => ({ ...c, h: c.c * 1.001, l: c.c * 0.999 })));
  assert.ok(wide.spikeBps >= 100);
});

test('staleness ignores gaps between sampled print windows; confidenceAt summarises one minute', () => {
  const prints = [{ t: T0, publishTime: T0, price: 4000, conf: 0.4, publishers: 17 }, { t: T0 + 3600, publishTime: T0 + 3600, price: 4000, conf: 0.4, publishers: 16 }];
  assert.equal(D.staleness([], prints, () => 'core', { samplingGapSec: 90 }).maxGapSec, 0);
  const c = D.confidenceAt([{ t: T0 + 1, price: 4000, conf: 4, publishers: 17 }, { t: T0 + 2, price: 4000, conf: 2, publishers: 15 }], T0);
  assert.equal(c.minPublishers, 15);
  assert.equal(c.maxConfBps, 10);
});

test('USD/JPY: parsed like EUR/USD (reference day, 16:59 ET), thin Hyperliquid reference, 17:00→17:00 ET plan', async () => {
  const { PYTH_CODES } = await import('../src/rules.js');
  const s = parseRulesDeterministic(M['usdjpy-up-or-down-on-november-9-2026']);
  assert.deepEqual([s.pythCode, s.instrument, s.kind, s.closeCandleET, s.tieRule, s.priorDayRule], ['FX.USD/JPY', 'USDJPY', 'close-vs-prior-close', '16:59', '50-50', 'reference-day']);
  assert.equal(PYTH_CODES['FX.USD/JPY'].hlCoin, 'xyz:JPY');
  assert.equal(PYTH_CODES['FX.USD/JPY'].hlThin, true);
  const jpy = P.feedBySymbol(SYM, 'FX.USD/JPY');
  const plan = settlementPlan(s, [jpy], {}, Date.parse('2026-11-09T12:00:00Z') / 1000);
  assert.equal(iso(plan.sessions[0].settleT), '2026-11-09T21:59:00.000Z');
  assert.equal(S.liquidityState(S.parseSchedule(jpy.schedule), 'USDJPY', Date.parse('2026-11-10T02:00:00Z')), 'core'); // Tokyo
});
