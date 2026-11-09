import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRulesDeterministic, validateAiSpec } from '../src/rules.js';
import { parseMarketRef } from '../src/polymarket.js';

const M = JSON.parse(readFileSync(new URL('./fixtures/markets.json', import.meta.url)));

test('up/down market: close vs prior close, ties 50-50, Pyth CLL active month', () => {
  const s = parseRulesDeterministic(M['wti-up-or-down-on-november-9-2026']);
  assert.equal(s.source, 'pyth');
  assert.equal(s.pythCode, 'CLL');
  assert.equal(s.instrument, 'WTI');
  assert.equal(s.kind, 'close-vs-prior-close');
  assert.equal(s.field, 'close');
  assert.equal(s.tieRule, '50-50');
  assert.equal(s.monthRule, 'active-month');
  assert.equal(s.rollSessions, 3);
  assert.equal(s.candle, '1m');
  assert.deepEqual(s.window, { type: 'day', day: '2026-11-09' });
  assert.match(s.fallbackSource, /ICE/);
});

test('close-above market: threshold from the question, tie → No', () => {
  const s = parseRulesDeterministic(M['wti-closes-above-94-on-november-9-2026']);
  assert.equal(s.kind, 'close-above');
  assert.equal(s.threshold, 94);
  assert.equal(s.comparator, '>');
  assert.equal(s.tieRule, 'No');
});

test('hit-high weekly market: High field, >=, week window, notes the one-date wording', () => {
  const s = parseRulesDeterministic(M['will-wti-reach-120-by-november-9-2026']);
  assert.equal(s.kind, 'hit-high');
  assert.equal(s.field, 'high');
  assert.equal(s.comparator, '>=');
  assert.equal(s.threshold, 120);
  assert.equal(s.window.type, 'week');
  assert.equal(s.window.startDay, '2026-11-09');
  assert.ok(s.window.notBefore);
  assert.ok(s.edgeCases.some((e) => /Week of/.test(e)));
});

test('monthly market window', () => {
  const s = parseRulesDeterministic(M['will-wti-reach-150-in-november-2026']);
  assert.equal(s.window.type, 'month');
  assert.equal(s.window.month, '2026-11');
  assert.equal(s.threshold, 150);
});

test('non-Pyth market is recognised as out of scope', () => {
  const s = parseRulesDeterministic({ question: 'Bitcoin Up or Down?', rules: 'This market resolves using the Binance BTC/USDT 1 minute candle close.', resolutionSource: 'https://www.binance.com', endDate: '2026-11-09T00:00:00Z' });
  assert.equal(s.source, 'binance');
});

test('AI output is validated in code: invented numbers and codes are rejected', () => {
  const m = M['wti-closes-above-94-on-november-9-2026'];
  const { ok, rejected } = validateAiSpec({ source: 'pyth', pythCode: 'XYZ', field: 'close', kind: 'close-above', comparator: '>', threshold: 97, monthRule: 'active-month', rollSessions: 3, edgeCases: [], tieRule: 'No', fallbackSource: null, windowDescription: 'x' }, m);
  assert.equal(ok.source, 'pyth');
  assert.equal(ok.threshold, undefined);
  assert.equal(ok.pythCode, undefined);
  assert.ok(rejected.some((r) => r.startsWith('threshold')));
  assert.ok(rejected.some((r) => r.startsWith('pythCode')));
  const bad = validateAiSpec({ source: 'oracle-of-delphi', field: 'mid' }, m);
  assert.ok(bad.rejected.some((r) => r.startsWith('source')));
});

test('parseMarketRef handles event URLs, market URLs and slugs', () => {
  assert.deepEqual(parseMarketRef('https://polymarket.com/event/wti-closes-above-on-november-9-2026/wti-closes-above-94-on-november-9-2026'), { eventSlug: 'wti-closes-above-on-november-9-2026', marketSlug: 'wti-closes-above-94-on-november-9-2026' });
  assert.deepEqual(parseMarketRef('https://polymarket.com/event/wti-up-or-down-on-november-9-2026'), { eventSlug: 'wti-up-or-down-on-november-9-2026', marketSlug: undefined });
  assert.deepEqual(parseMarketRef('some-slug'), { marketSlug: 'some-slug' });
});
