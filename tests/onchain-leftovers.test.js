import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareOnchain, onchainLine, KNOWN_OBJECTS, SUI_STALE_THRESHOLD_SEC } from '../src/onchain.js';
import { classify, applyMemories, precedentHeadline, HISTORY } from '../src/learn.js';
import { alreadyHit } from '../src/check.js';
import * as mem from '../src/memory.js';

const NOWS = 1794226000;

test('on-chain record: matches within 0.5 bps of the same-second Pyth print; age and live diff reported', () => {
  const o = compareOnchain({ onchain: { price: 4100.969, conf: 0.32, publishTime: NOWS - 3600 }, live: { price: 4108.95, publishTime: NOWS }, same: { price: 4100.969 }, nowSec: NOWS });
  assert.equal(o.status, 'matches');
  assert.equal(o.ageMin, 60);
  assert.equal(o.vsSameSecondBps, 0);
  assert.ok(o.vsLiveBps < -19 && o.vsLiveBps > -20);
  assert.match(o.notes[0], /60 min old/);
});

test('on-chain record: differs → note; fresh copy → no staleness note; no same-second print → unverified', () => {
  const d = compareOnchain({ onchain: { price: 4101, conf: 0.3, publishTime: NOWS - 10 }, live: null, same: { price: 4100 }, nowSec: NOWS });
  assert.equal(d.status, 'differs');
  assert.equal(d.notes.length, 1);
  assert.match(d.notes[0], /differs/);
  const u = compareOnchain({ onchain: { price: 4101, conf: 0.3, publishTime: NOWS - SUI_STALE_THRESHOLD_SEC }, live: null, same: null, nowSec: NOWS });
  assert.equal(u.status, 'unverified');
  assert.equal(u.notes.length, 0);
});

test('on-chain line names Tatum, or labels the public node when it served a read', () => {
  const base = { ok: true, ...compareOnchain({ onchain: { price: 4100.969, conf: 0.32, publishTime: NOWS - 600 }, live: { price: 4100.969 }, same: { price: 4100.969 }, nowSec: NOWS }), objectId: '0xabc', version: '7', checkpoint: '1' };
  assert.match(onchainLine({ ...base, provider: 'tatum' }), /^On-chain record \(Sui, via Tatum\): price 4100.969 ± 0.32 at .*10 min old; matches/);
  assert.match(onchainLine({ ...base, provider: 'tatum+public-fullnode' }), /public node used on a quota error/);
  assert.match(onchainLine({ ok: false, error: 'boom' }), /not read — boom/);
  assert.equal(Object.keys(KNOWN_OBJECTS).length, 3);
});

const ctx = { instrument: 'XAU', feed: 'Metal.XAU/USD', settleMinuteET: 16 * 60 + 59 };
const NOW = Date.parse('2026-11-09T12:00:00Z');
const rec = (o) => { const text = mem.encode('incident', { instrument: 'XAU', feed: 'Metal.XAU/USD', pattern: 'confidence', ratio: 6, when: '2026-11-06T21:55:00Z', ...o }); return { text, record: mem.decode(text) }; };

test('dedupe keeps the STRONGEST copy of the same event, whatever the recall order', () => {
  const weak = { blobId: 'weak', ...rec({ severity: '1.5' }) };
  const strong = { blobId: 'strong', ...rec({ severity: '5.9' }) };
  for (const order of [[weak, strong], [strong, weak]]) {
    const c = classify(order, ctx, NOW);
    assert.equal(c.sameWindow.length, 1);
    assert.equal(c.sameWindow[0].blobId, 'strong');
    assert.match(c.ignored.find((i) => i.blobId === 'weak').reason, /duplicate/);
  }
});

test('missing severity defaults to the lowest value: listed as a precedent but adds no points or headline', () => {
  assert.equal(HISTORY.missingSeverity, 0);
  const out = applyMemories({}, [{ blobId: 'nosev', ...rec({}) }], ctx, { nowMs: NOW });
  assert.equal(out.precedents.length, 1);
  assert.equal(out.precedents[0].weight, 0);
  assert.equal(out.after.score, out.before.score);
  assert.equal(precedentHeadline(out.precedents), null);
});

test('headline wording follows the strongest precedent type', () => {
  assert.equal(precedentHeadline([{ pattern: 'confidence', weight: 0.5, offsetMin: 4 }]), "Pyth's confidence has blown out before, near this settlement minute (4 min before it)");
  assert.equal(precedentHeadline([{ pattern: 'confidence', weight: 0.5, offsetMin: 0 }]), "Pyth's confidence has blown out before, at this exact settlement minute");
  assert.match(precedentHeadline([{ pattern: 'confidence', weight: 0.5, offsetMin: -3 }]), /\(3 min after it\)/);
  assert.match(precedentHeadline([{ pattern: 'spike-revert', weight: 0.6, offsetMin: 0 }, { pattern: 'confidence', weight: 0.2, offsetMin: 2 }]), /spiked and snapped back.*\(and shown confidence there\)/);
  assert.match(precedentHeadline([{ pattern: 'stale', weight: 0.1, offsetMin: 1 }]), /gone stale/);
});

test('distance is not scored for a hit market that was already hit', () => {
  const cs = [{ t: 60, h: 4390, l: 4380 }, { t: 120, h: 4401, l: 4390 }, { t: 180, h: 4395, l: 4385 }];
  assert.equal(alreadyHit({ kind: 'hit-high' }, 4400, cs).t, 120);
  assert.equal(alreadyHit({ kind: 'hit-high' }, 4500, cs), null);
  assert.equal(alreadyHit({ kind: 'hit-low' }, 4381, cs).t, 60);
  assert.equal(alreadyHit({ kind: 'close-above' }, 4400, cs), null);
});

test('report: precedent headline leads only when the band is elevated or high; otherwise a secondary line', async () => {
  const { buildReport } = await import('../src/report.js');
  const P = [{ pattern: 'confidence', weight: 0.4, offsetMin: 4, line: '6 Nov: confidence 23.5× normal', blobId: 'd08odBwCOEO2' }];
  const base = (score, band) => ({
    market: { question: 'Gold Up or Down', url: 'u', endDate: 'e', outcomes: [] }, spec: { source: 'pyth', kind: 'close-vs-prior-close', edgeCases: [], ruleCheck: { agreements: [], disagreements: [], filledByAi: [], rejected: [] } },
    plan: { sessions: [{ day: '2026-11-09', contract: 'Metal.XAU/USD', settleT: 1794261540, open: 1, close: 2 }], notes: [] }, gaps: [], dataSources: [], memory: { backend: 'walrus-mainnet', recalled: 1, errors: [] },
    learning: { precedents: P, otherSameFeed: [], changes: [{ factor: 'history', points: 7 }], used: [], ignored: [], before: { score: 12 }, after: { score }, explanation: '' },
    score: { score, band, reasons: [], notMeasured: [] },
  });
  const low = buildReport(base(19, 'low'));
  assert.match(low.verdict, /^Settlement price looks clean so far/);
  assert.match(low.secondary, /^Precedent: Pyth's confidence has blown out before, near this settlement minute \(4 min before it\)/);
  const hi = buildReport(base(45, 'elevated'));
  assert.match(hi.verdict, /^Pyth's confidence has blown out before, near this settlement minute \(4 min before it\) — Settlement Risk Score 45\/100/);
  assert.equal(hi.secondary, null);
});
