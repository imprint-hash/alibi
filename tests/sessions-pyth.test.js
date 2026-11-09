import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as S from '../src/sessions.js';
import * as P from '../src/pyth.js';

const symbols = JSON.parse(readFileSync(new URL('./fixtures/pyth-cll-symbols.json', import.meta.url)));
const contracts = P.contractsFromSymbols(symbols, 'CLL');
const sched = S.parseSchedule(contracts.find((c) => c.symbol === 'Commodities.CLLZ6/USD').schedule);
const iso = (ms) => new Date(ms).toISOString();

test('last trading day is read from the Pyth description', () => {
  assert.equal(P.lastTradingDayFromDescription('PYTH PRICE IN USD FOR WTI CRUDE 19 NOVEMBER 2026'), '2026-11-19');
  assert.equal(P.lastTradingDayFromDescription('no date'), null);
  assert.equal(contracts.find((c) => c.symbol === 'Commodities.CLLF7/USD').lastTradingDay, '2026-12-18');
});

test('Monday session opens Sunday 23:00 London and closes Monday 23:00 (matches the market end time)', () => {
  const s = S.sessionForDay(sched, '2026-11-09');
  assert.equal(iso(s.open), '2026-11-08T23:00:00.000Z');
  assert.equal(iso(s.close), '2026-11-09T23:00:00.000Z');
});

test('Tuesday session opens 01:00 London (8 PM ET prior day)', () => {
  const s = S.sessionForDay(sched, '2026-11-10');
  assert.equal(iso(s.open), '2026-11-10T01:00:00.000Z');
});

test('Saturday and Sunday are not trading days; holiday early closes come from the Pyth schedule', () => {
  assert.equal(S.sessionForDay(sched, '2026-11-14'), null);
  assert.equal(S.sessionForDay(sched, '2026-11-08'), null); // Sunday 23:00 opening belongs to Monday
  assert.equal(iso(S.sessionForDay(sched, '2026-11-26').close), '2026-11-26T18:30:00.000Z');
  assert.deepEqual(S.tradingDays(sched, '2026-11-06', '2026-11-10'), ['2026-11-06', '2026-11-09', '2026-11-10']);
});

test('isOpen and liquidity state', () => {
  assert.equal(S.isOpen(sched, Date.parse('2026-11-08T19:00:00Z')), false);
  assert.equal(S.isOpen(sched, Date.parse('2026-11-08T23:30:00Z')), true);
  assert.equal(S.liquidityState(sched, 'WTI', Date.parse('2026-11-09T15:00:00Z')), 'core'); // 10:00 ET
  assert.equal(S.liquidityState(sched, 'WTI', Date.parse('2026-11-09T22:59:00Z')), 'thin'); // 17:59 ET, after settlement
  assert.equal(S.liquidityState(sched, 'WTI', Date.parse('2026-11-14T12:00:00Z')), 'closed');
});

test('zonedToUtc handles DST zones', () => {
  assert.equal(iso(S.zonedToUtc(2026, 7, 1, 12, 0, 'Europe/London')), '2026-07-01T11:00:00.000Z');
  assert.equal(iso(S.zonedToUtc(2026, 11, 9, 12, 0, 'America/New_York')), '2026-11-09T17:00:00.000Z');
});

test('Active Month: nearest contract, rolling at the open of its third-to-last session', () => {
  assert.equal(P.activeContract(contracts, '2026-11-09').contract.symbol, 'Commodities.CLLZ6/USD');
  assert.equal(P.activeContract(contracts, '2026-11-16').contract.symbol, 'Commodities.CLLZ6/USD');
  // CLLZ6 last trades 19 Nov; its final three sessions are 17, 18, 19 Nov → CLLF7 is active from 17 Nov.
  assert.equal(P.activeContract(contracts, '2026-11-17').contract.symbol, 'Commodities.CLLF7/USD');
  assert.equal(P.activeContract(contracts, '2026-11-17').next.symbol, 'Commodities.CLLG7/USD');
});

test('printsToCandles builds OHLC per minute', () => {
  const c = P.printsToCandles([{ t: 60, price: 1 }, { t: 70, price: 3 }, { t: 80, price: 2 }, { t: 125, price: 5 }]);
  assert.deepEqual(c[0], { t: 60, o: 1, h: 3, l: 1, c: 2, v: 3 });
  assert.equal(c[1].t, 120);
});
