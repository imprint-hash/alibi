// Regression tests for the issues found in the 9 Nov audit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as S from '../src/sessions.js';
import * as P from '../src/pyth.js';
import * as D from '../src/detect.js';
import * as mem from '../src/memory.js';
import { parseRulesDeterministic } from '../src/rules.js';
import { priorReferenceDay, effectiveClose, settlementPlan } from '../src/check.js';
import { classify, applyMemories } from '../src/learn.js';
import { isQuotaError, isRateLimit } from '../src/sui.js';

const M = JSON.parse(readFileSync(new URL('./fixtures/markets.json', import.meta.url)));
const SYM = JSON.parse(readFileSync(new URL('./fixtures/pyth-spot-symbols.json', import.meta.url)));
const xau = P.feedBySymbol(SYM, 'Metal.XAU/USD');
const eur = P.feedBySymbol(SYM, 'FX.EUR/USD');
const iso = (s) => new Date(s * 1000).toISOString();
const xauSpec = () => parseRulesDeterministic(M['xauusd-up-or-down-on-november-9-2026']);
const eurSpec = () => parseRulesDeterministic(M['eurusd-up-or-down-on-november-9-2026']);

test('rules: metals compare with the prior TRADING day, EUR/USD with the prior REFERENCE day', () => {
  assert.equal(xauSpec().priorDayRule, 'trading-day');
  assert.equal(eurSpec().priorDayRule, 'reference-day');
});

test('prior day on holidays: an early-close trading day (Thanksgiving) still counts for gold', () => {
  const sc = S.parseSchedule(xau.schedule);
  // 26 Nov 2026 (Thanksgiving) closes 14:30 ET, 27 Nov closes 14:45 ET: no 16:59 candle on either day.
  assert.equal(priorReferenceDay(xauSpec(), sc, '2026-11-27'), '2026-11-26');
  assert.equal(priorReferenceDay(xauSpec(), sc, '2026-11-30'), '2026-11-27');
  assert.equal(priorReferenceDay(xauSpec(), sc, '2026-11-09'), '2026-11-06');
  // A "reference day" rule needs the 16:59 ET candle inside the session, so it skips both early closes.
  assert.equal(priorReferenceDay({ ...xauSpec(), priorDayRule: 'reference-day' }, sc, '2026-11-30'), '2026-11-25');
});

test('effective close: exact candle, else last candle before it in the same session, never an earlier session', () => {
  const settleT = 1000 * 60, open = 900 * 60;
  const cs = [{ t: 850 * 60, c: 1 }, { t: 950 * 60, c: 2 }, { t: 999 * 60, c: 3 }, { t: 1000 * 60, c: 4 }];
  assert.deepEqual(effectiveClose(cs, { settleT, sessionOpen: open }), { candle: cs[3], exact: true });
  assert.deepEqual(effectiveClose(cs.slice(0, 3), { settleT, sessionOpen: open }), { candle: cs[2], exact: false });
  assert.equal(effectiveClose(cs.slice(0, 1), { settleT, sessionOpen: open }), null);
});

test('spot metal edge cases never mention an Active Month; WTI still does', () => {
  assert.ok(!xauSpec().edgeCases.some((e) => /Active Month/.test(e)));
  assert.ok(xauSpec().edgeCases.some((e) => /not a trading day/.test(e)));
  assert.ok(xauSpec().edgeCases.some((e) => /CME COMEX/.test(e)));
  assert.ok(parseRulesDeterministic(M['wti-up-or-down-on-november-9-2026']).edgeCases.some((e) => /Active Month/.test(e)));
});

test('EUR/USD plan: the market day is 17:00 ET → 17:00 ET, not the calendar day', () => {
  const plan = settlementPlan(eurSpec(), [eur], {}, Date.parse('2026-11-09T12:00:00Z') / 1000);
  const s = plan.sessions[0];
  assert.equal(iso(s.settleT), '2026-11-09T21:59:00.000Z');
  assert.equal(iso(s.open), '2026-11-08T22:00:00.000Z'); // Sunday 17:00 ET
  assert.equal(iso(s.close), '2026-11-09T22:00:00.000Z');
});

test('detectors: zero or NaN prices never become bps values', () => {
  assert.equal(D.thresholdDistance({ price: 100, threshold: 0 }).measured, false);
  assert.equal(D.thresholdDistance({ price: NaN, threshold: 100 }).measured, false);
  const t = Array.from({ length: 30 }, (_, i) => ({ t: i * 60, o: 100, h: 100, l: 100, c: 100 }));
  const zeroRef = t.map((c) => ({ ...c, o: 0, h: 0, l: 0, c: 0 }));
  const dv = D.divergence(t, [{ name: 'zero', candles: zeroRef }]);
  assert.equal(dv.measured, false);
  const bad = [...t.slice(0, 10), { t: 600, o: 100, h: NaN, l: NaN, c: 100 }, ...t.slice(11)];
  assert.equal(D.spikeRevert(bad, []).events.length, 0);
});

test('confidence: a zero baseline is "not measured", never a fabricated 0× ratio', () => {
  const prints = Array.from({ length: 20 }, (_, i) => ({ t: i, price: 100, conf: i === 5 ? 0.1 : 0 }));
  const c = D.confidenceBlowout(prints);
  assert.equal(c.measured, false);
  assert.equal(D.confidenceAt([{ t: 0, price: 100, conf: 0.01 }], 0).minPublishers, null);
});

test('memory: the same event written twice (or recalled twice) counts once, and the duplicate is listed', () => {
  const ctx = { instrument: 'XAU', feed: 'Metal.XAU/USD', settleMinuteET: 16 * 60 + 59 };
  const text = mem.encode('incident', { instrument: 'XAU', feed: 'Metal.XAU/USD', pattern: 'confidence', ratio: 23.5, when: '2026-11-06T21:55:00Z', severity: '5.88' });
  const rec = mem.decode(text);
  const NOW = Date.parse('2026-11-09T12:00:00Z');
  const once = applyMemories({}, [{ blobId: 'a', text, record: rec }], ctx, { nowMs: NOW });
  const twice = applyMemories({}, [{ blobId: 'a', text, record: rec }, { blobId: 'a', text, record: rec }, { blobId: 'b', text, record: rec }], ctx, { nowMs: NOW });
  assert.equal(twice.precedents.length, 1);
  assert.equal(twice.history.weightSum, once.history.weightSum);
  assert.equal(twice.after.score, once.after.score);
  const c = classify([{ blobId: 'a', text, record: rec }, { blobId: 'b', text, record: rec }], ctx, NOW);
  assert.match(c.ignored[0].reason, /duplicate/);
});

test('Tatum fallback only on quota/429: timeouts and ids containing "429" do not fall back', () => {
  assert.equal(isQuotaError({ code: 'UNAVAILABLE', message: 'Received HTTP status code 429' }), true);
  assert.equal(isQuotaError(new Error('Deadline exceeded after 20s')), false);
  assert.equal(isQuotaError(new Error('object 0xab429cd not found')), false);
  assert.equal(isRateLimit(new Error('object 0xab429cd not found')), false);
  assert.equal(isRateLimit(new Error('Received HTTP status code 429')), true);
});
