import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction, Inputs } from '@mysten/sui/transactions';
import { toBase64 } from '@mysten/sui/utils';
import * as pay from '../src/pay.js';

const KEY = 'test-hmac-key';
const TO = '0x' + 'ab'.repeat(32);
const PAYER = '0x' + 'cd'.repeat(32);
const NOW = Date.parse('2026-11-09T16:00:00Z');
const DIGEST = '8DDPzvZgMnZMGxHitCxJniWSY3QsjJDN3NvaZd1MGP6P';
const opts = { key: KEY, to: TO };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const txFor = (over = {}) => ({
  digest: DIGEST, status: { success: true }, timestampMs: NOW + 5000, transaction: { sender: PAYER },
  balanceChanges: [{ coinType: pay.USDC, address: TO, amount: '50000' }, { coinType: pay.USDC, address: PAYER, amount: '-50000' }],
  ...over,
});

test('402 body follows x402 v2 PaymentRequired with USDC on sui:mainnet', () => {
  const q = pay.paymentRequired({ resourceUrl: 'http://x/api/agent/check', now: NOW, ...opts });
  assert.equal(q.x402Version, 2);
  assert.equal(q.resource.url, 'http://x/api/agent/check');
  const a = q.accepts[0];
  assert.equal(a.scheme, 'exact');
  assert.equal(a.network, 'sui:mainnet');
  assert.equal(a.asset, '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC');
  assert.equal(a.amount, '50000');
  assert.equal(a.extra.priceUsdc, '0.05');
  assert.equal(a.payTo, TO);
  assert.equal(a.maxTimeoutSeconds, 600);
  assert.equal(a.extra.expiresAt, '2026-11-09T16:10:00.000Z');
  assert.ok(pay.parseNonce(a.extra.nonce, { now: NOW, ...opts }));
  const b = pay.paymentRequired({ resourceUrl: 'u', now: NOW, ...opts });
  assert.notEqual(a.extra.nonce, b.accepts[0].extra.nonce, 'each quote has a unique nonce');
});

test('returning agents (2+ remembered checks) get a lower rate bound to their address', () => {
  const q = pay.paymentRequired({ resourceUrl: 'u', payer: PAYER, history: { count: 2, source: 'walrus' }, now: NOW, ...opts });
  assert.equal(q.accepts[0].amount, '40000');
  assert.equal(q.accepts[0].extra.rate, 'returning');
  const n = pay.parseNonce(q.accepts[0].extra.nonce, { now: NOW, ...opts });
  assert.equal(n.payer, PAYER);
  assert.throws(() => pay.checkTx(txFor({ transaction: { sender: '0x' + 'ee'.repeat(32) } }), { to: TO, amount: n.amount, issuedMs: n.issuedMs, expMs: n.expMs, payer: n.payer }), /different payer/);
  const one = pay.paymentRequired({ resourceUrl: 'u', payer: PAYER, history: { count: 1 }, now: NOW, ...opts });
  assert.equal(one.accepts[0].amount, '50000');
});

test('nonce: tampering, wrong server and expiry are rejected', () => {
  const n = pay.makeNonce({ amount: 50000n, now: NOW, ...opts });
  assert.throws(() => pay.parseNonce(n.replace('.50000.', '.1.'), { now: NOW, ...opts }), /not issued/);
  assert.throws(() => pay.parseNonce(n, { now: NOW, key: 'other', to: TO }), /not issued/);
  assert.throws(() => pay.parseNonce(n, { now: NOW, key: KEY, to: PAYER }), /not issued/);
  assert.throws(() => pay.parseNonce(n, { now: NOW + 601_000, ...opts }), (e) => e.code === 'expired');
  assert.throws(() => pay.parseNonce('garbage', { now: NOW, ...opts }), (e) => e.code === 'invalid_nonce');
});

test('header parsing: X-PAYMENT and PAYMENT-SIGNATURE, base64 or JSON, both modes', () => {
  const nonce = pay.makeNonce({ amount: 50000n, now: NOW, ...opts });
  assert.equal(pay.paymentHeader({ 'x-payment': 'a' }), 'a');
  assert.equal(pay.paymentHeader({ 'payment-signature': 'b', 'x-payment': 'a' }), 'b');
  assert.equal(pay.paymentHeader({}), null);
  const d = pay.parsePayment(b64({ x402Version: 2, accepted: { scheme: 'exact', network: 'sui:mainnet' }, payload: { digest: DIGEST, nonce } }));
  assert.deepEqual([d.mode, d.digest, d.nonce], ['digest', DIGEST, nonce]);
  const t = pay.parsePayment(JSON.stringify({ accepted: { extra: { nonce } }, payload: { transaction: 'AAA=', signature: 'sig' } }));
  assert.equal(t.mode, 'transaction');
  assert.equal(t.nonce, nonce);
  assert.throws(() => pay.parsePayment(null), (e) => e.code === 'missing_payment');
  assert.throws(() => pay.parsePayment('%%%not-base64-json'), (e) => e.code === 'invalid_payload');
  assert.throws(() => pay.parsePayment(b64({ accepted: { network: 'eip155:8453' }, payload: { digest: DIGEST, nonce } })), (e) => e.code === 'invalid_network');
  assert.throws(() => pay.parsePayment(b64({ payload: { digest: 'not a digest!', nonce } })), (e) => e.code === 'invalid_payload');
  assert.throws(() => pay.parsePayment(b64({ payload: { digest: DIGEST } })), (e) => e.code === 'invalid_nonce');
});

test('amount check: USDC to payTo must cover the quote; other coins and recipients do not count', () => {
  const q = { to: TO, amount: 50000n, issuedMs: NOW, expMs: NOW + 600_000, now: NOW + 10_000 };
  assert.equal(pay.checkTx(txFor(), q).paid, 50000n);
  assert.equal(pay.checkTx(txFor(), q).payer, PAYER);
  assert.throws(() => pay.checkTx(txFor({ balanceChanges: [{ coinType: pay.USDC, address: TO, amount: '49999' }] }), q), (e) => e.code === 'insufficient_amount');
  assert.throws(() => pay.checkTx(txFor({ balanceChanges: [{ coinType: '0x2::sui::SUI', address: TO, amount: '999999999' }] }), q), (e) => e.code === 'insufficient_amount');
  assert.throws(() => pay.checkTx(txFor({ balanceChanges: [{ coinType: pay.USDC, address: PAYER, amount: '50000' }] }), q), (e) => e.code === 'insufficient_amount');
  assert.throws(() => pay.checkTx(txFor({ status: { success: false, error: 'InsufficientCoinBalance' } }), q), (e) => e.code === 'tx_failed');
  assert.throws(() => pay.checkTx(txFor({ transaction: {} }), q), (e) => e.code === 'no_sender');
});

test('expiry: a tx from before the quote or after it expired is rejected', () => {
  const q = { to: TO, amount: 50000n, issuedMs: NOW, expMs: NOW + 600_000, now: NOW };
  assert.throws(() => pay.checkTx(txFor({ timestampMs: NOW - 3_600_000 }), q), (e) => e.code === 'tx_too_old');
  assert.throws(() => pay.checkTx(txFor({ timestampMs: NOW + 700_000 }), q), (e) => e.code === 'expired');
  assert.ok(pay.checkTx(txFor({ timestampMs: null }), { ...q, now: NOW + 1000 }));
});

test('replay: a used digest or nonce is refused, persistently and while in flight', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'alibi-pay-')), 'used.json');
  pay.markUsed({ digest: DIGEST, nonce: 'n1' }, file);
  const store = pay.usedStore(file);
  assert.throws(() => pay.assertFresh({ digest: DIGEST }, store), (e) => e.code === 'replay');
  assert.throws(() => pay.assertFresh({ nonce: 'n1' }, store), (e) => e.code === 'replay');
  assert.doesNotThrow(() => pay.assertFresh({ digest: 'Other1111111111111111111111111111111111111111', nonce: 'n2' }, store));
  const unlock = pay.lock(['n:n3']);
  assert.throws(() => pay.assertFresh({ nonce: 'n3' }, { digests: {}, nonces: {} }), (e) => e.code === 'replay');
  unlock();
  assert.doesNotThrow(() => pay.assertFresh({ nonce: 'n3' }, { digests: {}, nonces: {} }));
});

test('verification mock (digest mode): reads the tx through the injected Sui reader', async () => {
  const nonce = pay.makeNonce({ amount: 50000n, now: NOW, ...opts });
  const calls = [];
  const read = async (method, fn) => { calls.push(method); return { value: await fn({ getTransaction: async ({ digest }) => ({ Transaction: txFor({ digest }) }) }), provider: 'tatum' }; };
  const v = await pay.verifyPayment({ mode: 'digest', digest: DIGEST.replace('8DD', '9DD'), nonce }, { read, now: NOW + 10_000, ...opts });
  const done = await v.settle();
  assert.equal(done.verifiedVia, 'tatum');
  assert.equal(done.payer, PAYER);
  assert.equal(done.paid, 50000n);
  assert.deepEqual(calls, ['core.getTransaction']);
});

test('verification mock (transaction mode): signature checked, simulated, then executed and re-read', async () => {
  const kp = new Ed25519Keypair();
  const sender = kp.toSuiAddress();
  const ref = (n) => ({ objectId: '0x' + String(n).repeat(64), version: '1', digest: '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi' });
  const tx = new Transaction();
  tx.setSender(sender); tx.setGasPrice(1000); tx.setGasBudget(10_000_000); tx.setGasPayment([ref(1)]);
  tx.transferObjects([tx.object(Inputs.ObjectRef(ref(2)))], TO);
  const bytes = await tx.build();
  const { signature } = await kp.signTransaction(bytes);
  const nonce = pay.makeNonce({ amount: 50000n, now: NOW, ...opts });
  const good = txFor({ transaction: { sender }, timestampMs: null });
  const calls = [];
  const client = {
    simulateTransaction: async () => ({ Transaction: { ...good, transaction: undefined } }),
    executeTransaction: async () => ({ Transaction: good }),
    waitForTransaction: async () => ({}),
    getTransaction: async () => ({ Transaction: good }),
  };
  const read = async (method, fn) => { calls.push(method); return { value: await fn(client), provider: 'tatum' }; };
  const v = await pay.verifyPayment({ mode: 'transaction', transaction: toBase64(bytes), signature, nonce }, { read, now: NOW + 1000, clock: () => NOW + 2000, ...opts });
  assert.equal(v.payer, sender);
  assert.deepEqual(calls, ['core.simulateTransaction'], 'nothing executes before the work is done');
  const done = await v.settle();
  assert.equal(done.executedVia, 'tatum');
  assert.deepEqual(calls, ['core.simulateTransaction', 'core.executeTransaction', 'core.waitForTransaction', 'core.getTransaction']);
  // a signature from another key is refused before any Sui call
  const other = await new Ed25519Keypair().signTransaction(bytes);
  await assert.rejects(pay.verifyPayment({ mode: 'transaction', transaction: toBase64(bytes), signature: other.signature, nonce }, { read, now: NOW + 1000, ...opts }), (e) => e.code === 'invalid_signature');
  // simulation that underpays is refused
  client.simulateTransaction = async () => ({ Transaction: { ...good, balanceChanges: [{ coinType: pay.USDC, address: TO, amount: '10' }] } });
  await assert.rejects(pay.verifyPayment({ mode: 'transaction', transaction: toBase64(bytes), signature, nonce }, { read, now: NOW + 1000, ...opts }), (e) => e.code === 'insufficient_amount');
});
