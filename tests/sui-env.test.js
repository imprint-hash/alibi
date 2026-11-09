import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceIdentifierBcs, parsePriceInfoJson, isQuotaError } from '../src/sui.js';
import { envStatus } from '../src/env.js';

test('PriceIdentifier BCS is 0x20 + 32 bytes', () => {
  const b = priceIdentifierBcs('e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43');
  assert.equal(b.length, 33);
  assert.equal(b[0], 0x20);
  assert.equal(b[1], 0xe6);
  assert.throws(() => priceIdentifierBcs('abcd'));
});

test('parsePriceInfoJson reads the gRPC JSON shape', () => {
  const json = { price_info: { attestation_time: '1794164372', price_feed: { price: { price: { negative: false, magnitude: '7584919107462' }, conf: '5595736538', expo: { negative: true, magnitude: '8' }, timestamp: '1794164372' } } } };
  const p = parsePriceInfoJson(json);
  assert.ok(Math.abs(p.price - 75849.19107462) < 1e-6);
  assert.ok(Math.abs(p.conf - 55.95736538) < 1e-6);
  assert.equal(p.expo, -8);
  assert.equal(p.publishTime, 1794164372);
  assert.equal(parsePriceInfoJson({}), null);
});

test('quota errors are recognised; other errors are not', () => {
  assert.equal(isQuotaError({ code: 'RESOURCE_EXHAUSTED' }), true);
  assert.equal(isQuotaError(new Error('Rate limit exceeded')), true);
  assert.equal(isQuotaError(new Error('object not found')), false);
});

test('envStatus reports only set/empty, never values', () => {
  process.env.ALIBI_TEST_SECRET = 'super-secret-value';
  const s = envStatus(['ALIBI_TEST_SECRET', 'ALIBI_TEST_MISSING']);
  assert.deepEqual(s, { ALIBI_TEST_SECRET: 'set', ALIBI_TEST_MISSING: 'empty' });
  assert.ok(!JSON.stringify(s).includes('super-secret'));
});
