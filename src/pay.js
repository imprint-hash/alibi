// Agent payments: an x402-style paywall for POST /api/agent/check, settled in native USDC on Sui mainnet.
// Follows the x402 "exact" scheme for Sui (coinbase/x402 specs/schemes/exact/scheme_exact_sui.md): the 402 body is a
// v2 PaymentRequired, the client answers with a base64 JSON PaymentPayload in PAYMENT-SIGNATURE (v2) or X-PAYMENT
// (v1 name). Two payload modes:
//   transaction  (spec): {transaction: base64 tx bytes, signature}; Alibi checks the signature, simulates through
//                Tatum, runs the check, then executes through Tatum (writes never fall back).
//   digest       (Alibi extension, pay-first): {digest, nonce}; the agent already executed the transfer.
// Both end in the same on-chain verification of the executed tx, read through Tatum gRPC (src/sui.js).
// Replay protection: each digest and each nonce is accepted once (results/agent-payments-used.json + the ledgers).
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Transaction } from '@mysten/sui/transactions';
import { verifyTransactionSignature } from '@mysten/sui/verify';
import { normalizeSuiAddress, normalizeStructTag, fromBase64 } from '@mysten/sui/utils';
import { secret } from './env.js';
import { suiRead } from './sui.js';
import { path, readJson, writeJson, appendJsonl, readJsonl } from './store.js';

// Native Circle USDC on Sui (checked on 9 Nov 2026 via Tatum getCoinMetadata: symbol USDC, 6 decimals, issued by Circle).
export const USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
export const USDC_DECIMALS = 6;
export const NETWORK = 'sui:mainnet';
export const SCHEME = 'exact';
export const PRICE = {
  standard: BigInt(process.env.ALIBI_AGENT_PRICE || 50_000), // 0.05 USDC
  returning: BigInt(process.env.ALIBI_AGENT_RETURNING_PRICE || 40_000), // 0.04 USDC
  returningAfter: 2, // paid checks remembered on Walrus before the returning rate applies
};
export const TIMEOUT_S = 600; // a quote is valid for 10 minutes
export const SKEW_MS = 30_000;
export const NS_AGENTS = 'alibi-agents';
const USED = path('results', 'agent-payments-used.json');
export const LEDGER = { results: path('results', 'agent-payments.jsonl'), proof: path('proof', 'agent-payments.jsonl') };

export const usdc = (base) => (Number(base) / 10 ** USDC_DECIMALS).toFixed(USDC_DECIMALS).replace(/0+$/, '').replace(/\.$/, '');
const norm = (a) => normalizeSuiAddress(String(a || ''));
const isAddr = (a) => /^0x[0-9a-fA-F]{1,64}$/.test(String(a || ''));
export const sameType = (a, b) => { try { return normalizeStructTag(a) === normalizeStructTag(b); } catch { return false; } };

export class PayError extends Error {
  constructor(code, message, status = 402) { super(message); this.code = code; this.status = status; }
}

export function payTo() {
  const a = secret('SUI_ADDRESS');
  if (!a) throw new PayError('not_configured', 'Alibi has no receiving address configured', 503);
  return norm(a);
}

function payKey() {
  const s = secret('ALIBI_PAY_SECRET');
  if (s) return s;
  const t = secret('TATUM_API_KEY'); // one-way derived fallback so quotes survive restarts; never printed
  if (!t) throw new PayError('not_configured', 'ALIBI_PAY_SECRET is not set', 503);
  return createHash('sha256').update(`alibi-x402-nonce|${t}`).digest('hex');
}
const mac = (body, key) => createHmac('sha256', key).update(body).digest('hex').slice(0, 32);

// ---- nonce: a signed, self-describing quote. v1.<issued>.<expires>.<rand>.<amount>.<payer|->.<mac> ----------------
export function makeNonce({ amount, payer = null, now = Date.now(), key = payKey(), to = payTo() }) {
  const issued = Math.floor(now / 1000);
  const body = ['v1', issued, issued + TIMEOUT_S, randomBytes(8).toString('hex'), String(amount), payer ? norm(payer) : '-'].join('.');
  return `${body}.${mac(`${body}|${to}`, key)}`;
}

export function parseNonce(nonce, { now = Date.now(), key = payKey(), to = payTo() } = {}) {
  const parts = String(nonce || '').split('.');
  if (parts.length !== 7 || parts[0] !== 'v1') throw new PayError('invalid_nonce', 'nonce is missing or malformed');
  const [, issued, expires, , amount, payer, sig] = parts;
  const want = mac(`${parts.slice(0, 6).join('.')}|${to}`, key);
  if (sig.length !== want.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(want))) throw new PayError('invalid_nonce', 'nonce was not issued by this Alibi server');
  const exp = Number(expires) * 1000;
  if (now > exp) throw new PayError('expired', `quote expired at ${new Date(exp).toISOString()}; request a new one`);
  return { nonce, issuedMs: Number(issued) * 1000, expMs: exp, amount: BigInt(amount), payer: payer === '-' ? null : payer };
}

// ---- 402 body ---------------------------------------------------------------------------------------------------
/** x402 v2 PaymentRequired (with v1's maxAmountRequired mirrored for older clients). */
export function paymentRequired({ resourceUrl, payer = null, history = null, error = null, now = Date.now(), key, to } = {}) {
  to ||= payTo();
  const returning = !!(payer && history && history.count >= PRICE.returningAfter);
  const amount = returning ? PRICE.returning : PRICE.standard;
  const nonce = makeNonce({ amount, payer: returning ? payer : null, now, key, to });
  const issued = Math.floor(now / 1000);
  return {
    x402Version: 2,
    error: error || 'X-PAYMENT header is required',
    resource: { url: resourceUrl, description: 'One Alibi settlement check of a Polymarket market (Pyth gold/silver), JSON report', mimeType: 'application/json' },
    accepts: [{
      scheme: SCHEME,
      network: NETWORK,
      amount: String(amount),
      maxAmountRequired: String(amount),
      asset: USDC,
      payTo: to,
      maxTimeoutSeconds: TIMEOUT_S,
      extra: {
        nonce,
        issuedAt: new Date(issued * 1000).toISOString(),
        expiresAt: new Date((issued + TIMEOUT_S) * 1000).toISOString(),
        decimals: USDC_DECIMALS,
        symbol: 'USDC',
        priceUsdc: usdc(amount),
        rate: returning ? 'returning' : 'standard',
        ...(returning ? { boundPayer: norm(payer), priorPaidChecks: history.count, historySource: history.source } : {}),
        modes: ['transaction', 'digest'],
        headers: { request: ['PAYMENT-SIGNATURE', 'X-PAYMENT'], response: ['PAYMENT-RESPONSE', 'X-PAYMENT-RESPONSE'] },
      },
    }],
  };
}

// ---- header parsing ---------------------------------------------------------------------------------------------
export function paymentHeader(headers = {}) {
  return headers['payment-signature'] || headers['x-payment'] || null;
}

/** Decodes a PaymentPayload (base64 JSON, or plain JSON). Returns {mode, nonce, digest?, transaction?, signature?}. */
export function parsePayment(raw) {
  if (!raw) throw new PayError('missing_payment', 'X-PAYMENT header is required');
  let obj;
  const s = String(raw).trim();
  try { obj = JSON.parse(s.startsWith('{') ? s : Buffer.from(s, 'base64').toString('utf8')); } catch { throw new PayError('invalid_payload', 'X-PAYMENT must be base64-encoded JSON'); }
  const p = obj?.payload || {};
  const acc = obj?.accepted || {};
  if (acc.scheme && acc.scheme !== SCHEME) throw new PayError('invalid_scheme', `scheme must be "${SCHEME}"`);
  if (acc.network && acc.network !== NETWORK) throw new PayError('invalid_network', `network must be "${NETWORK}"`);
  const nonce = p.nonce || acc.extra?.nonce;
  if (!nonce) throw new PayError('invalid_nonce', 'payload.nonce (or accepted.extra.nonce) is required');
  if (p.transaction && p.signature) return { mode: 'transaction', version: obj.x402Version ?? null, nonce, transaction: String(p.transaction), signature: String(p.signature) };
  if (p.digest) {
    if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(String(p.digest))) throw new PayError('invalid_payload', 'payload.digest is not a Sui transaction digest');
    return { mode: 'digest', version: obj.x402Version ?? null, nonce, digest: String(p.digest) };
  }
  throw new PayError('invalid_payload', 'payload needs {transaction, signature} or {digest}');
}

/** Encodes a value as base64 JSON (PaymentPayload / SettlementResponse headers). */
export const b64json = (o) => Buffer.from(JSON.stringify(o)).toString('base64');

// ---- on-chain checks (pure) ------------------------------------------------------------------------------------
/**
 * Checks an executed (or simulated) Sui transaction against a quote. tx = SDK Transaction shape:
 * {digest, status:{success}, balanceChanges:[{coinType,address,amount}], transaction:{sender}, timestampMs}.
 */
export function checkTx(tx, { to, amount, issuedMs, expMs, payer = null, now = Date.now(), simulated = false }) {
  if (!tx) throw new PayError('tx_not_found', 'transaction not found on Sui');
  if (!tx.status?.success) throw new PayError('tx_failed', `transaction failed on Sui${tx.status?.error ? `: ${JSON.stringify(tx.status.error).slice(0, 120)}` : ''}`);
  const sender = tx.transaction?.sender;
  if (!sender || !isAddr(sender)) throw new PayError('no_sender', 'transaction sender could not be read');
  if (payer && norm(sender) !== norm(payer)) throw new PayError('wrong_payer', 'this quote is bound to a different payer address');
  const paid = (tx.balanceChanges || []).filter((b) => sameType(b.coinType, USDC) && norm(b.address) === norm(to)).reduce((s, b) => s + BigInt(b.amount), 0n);
  if (paid < amount) throw new PayError('insufficient_amount', `USDC received by payTo is ${usdc(paid)}, quote needs ${usdc(amount)}`);
  if (!simulated) {
    const t = tx.timestampMs ?? now; // null until checkpointed: it was just executed
    if (t < issuedMs - SKEW_MS) throw new PayError('tx_too_old', 'transaction is older than the quote; pay again with this nonce');
    if (t > expMs + SKEW_MS) throw new PayError('expired', 'transaction landed after the quote expired');
  }
  return { payer: norm(sender), paid, timestampMs: tx.timestampMs ?? null };
}

// ---- replay store -----------------------------------------------------------------------------------------------
const pending = new Set();
export function usedStore(file = USED) {
  const s = readJson(file, { digests: {}, nonces: {} });
  for (const f of [LEDGER.results, LEDGER.proof]) for (const r of readJsonl(f)) { if (r.digest) s.digests[r.digest] ||= r.at || true; if (r.nonce) s.nonces[r.nonce] ||= r.at || true; }
  return s;
}
export function assertFresh({ digest, nonce }, store = usedStore()) {
  if (digest && (store.digests?.[digest] || pending.has(`d:${digest}`))) throw new PayError('replay', `transaction ${digest} has already paid for a check`);
  if (nonce && (store.nonces?.[nonce] || pending.has(`n:${nonce}`))) throw new PayError('replay', 'this quote (nonce) has already been used');
}
export function lock(keys) { for (const k of keys) pending.add(k); return () => keys.forEach((k) => pending.delete(k)); }
export function markUsed({ digest, nonce }, file = USED) {
  const s = readJson(file, { digests: {}, nonces: {} });
  const at = new Date().toISOString();
  if (digest) s.digests[digest] = at;
  if (nonce) s.nonces[nonce] = at;
  writeJson(file, s);
}

// ---- verification through Tatum ----------------------------------------------------------------------------------
const TX_INCLUDE = { balanceChanges: true, transaction: true, effects: true };
const txOf = (r) => r?.Transaction || r?.FailedTransaction || null;

async function readTx(digest, read) {
  for (let i = 0; i < 6; i++) {
    try {
      const r = await read('core.getTransaction', (c) => c.getTransaction({ digest, include: TX_INCLUDE }));
      return { tx: txOf(r.value), provider: r.provider };
    } catch (e) {
      if (!/not ?found|NOT_FOUND|could not find/i.test(String(e?.message || e)) || i === 5) throw e;
      await new Promise((ok) => setTimeout(ok, 1500));
    }
  }
}

/**
 * Pre-settlement verification. Returns { quote, payer, mode, digest?, settle() } where settle() executes (transaction
 * mode) and confirms the executed tx through Tatum. In digest mode settle() is a no-op returning the confirmed read.
 * `read` defaults to suiRead (Tatum first; reads fall back only on quota errors, writes never).
 */
export async function verifyPayment(p, { read = suiRead, now = Date.now(), key, to } = {}) {
  to ||= payTo();
  const quote = parseNonce(p.nonce, { now, key, to });
  const base = { to, amount: quote.amount, issuedMs: quote.issuedMs, expMs: quote.expMs, payer: quote.payer, now };

  if (p.mode === 'digest') {
    assertFresh({ digest: p.digest, nonce: p.nonce });
    const { tx, provider } = await readTx(p.digest, read);
    const r = checkTx(tx, base);
    const out = { quote, mode: 'digest', digest: p.digest, payer: r.payer, paid: r.paid, timestampMs: r.timestampMs, verifiedVia: provider, executedVia: 'agent' };
    return { ...out, settle: async () => out };
  }

  // transaction mode (x402 exact, Sui): signature → simulate → (caller runs the work) → execute → confirm
  let bytes, signer, sender, digest;
  try { bytes = fromBase64(p.transaction); } catch { throw new PayError('invalid_payload', 'payload.transaction is not base64'); }
  try { signer = (await verifyTransactionSignature(bytes, p.signature)).toSuiAddress(); } catch { throw new PayError('invalid_signature', 'signature does not verify over the transaction bytes'); }
  try { const t = Transaction.from(bytes); sender = t.getData().sender; digest = await t.getDigest(); } catch { throw new PayError('invalid_payload', 'transaction bytes could not be decoded'); }
  if (!sender || norm(sender) !== norm(signer)) throw new PayError('invalid_signature', 'signer is not the transaction sender');
  assertFresh({ digest, nonce: p.nonce });
  const sim = await read('core.simulateTransaction', (c) => c.simulateTransaction({ transaction: bytes, include: { balanceChanges: true, transaction: true, effects: true } }));
  const simTx = txOf(sim.value);
  if (simTx && !simTx.transaction) simTx.transaction = { sender };
  checkTx(simTx, { ...base, simulated: true });
  return {
    quote, mode: 'transaction', digest, payer: norm(sender), simulatedVia: sim.provider,
    settle: async () => {
      const ex = await read('core.executeTransaction', (c) => c.executeTransaction({ transaction: bytes, signatures: [p.signature], include: TX_INCLUDE }));
      const done = txOf(ex.value);
      if (!done?.status?.success) throw new PayError('tx_failed', 'payment transaction failed at execution');
      await read('core.waitForTransaction', (c) => c.waitForTransaction({ digest: done.digest, timeout: 30_000 })).catch(() => null);
      const { tx, provider } = await readTx(done.digest, read);
      const r = checkTx(tx, { ...base, now: Date.now() });
      return { quote, mode: 'transaction', digest: done.digest, payer: r.payer, paid: r.paid, timestampMs: r.timestampMs, simulatedVia: sim.provider, executedVia: ex.provider, verifiedVia: provider };
    },
  };
}

// ---- receipts, ledger, memory -----------------------------------------------------------------------------------
export function receipt(v, { market, score, band, memory }) {
  return {
    scheme: SCHEME, network: NETWORK, asset: USDC, amount: String(v.paid), amountUsdc: usdc(v.paid), rate: v.quote.payer ? 'returning' : 'standard',
    payTo: payTo(), payer: v.payer, digest: v.digest, mode: v.mode, nonce: v.quote.nonce,
    simulated_via: v.simulatedVia || null, executed_via: v.executedVia || null, verified_via: v.verifiedVia,
    tx_time: v.timestampMs ? new Date(v.timestampMs).toISOString() : null, at: new Date().toISOString(),
    market, score, band, explorer: `https://suiscan.xyz/mainnet/tx/${v.digest}`, memory: memory || null,
  };
}

export function recordPayment(rec) {
  markUsed({ digest: rec.digest, nonce: rec.nonce });
  const row = { at: rec.at, digest: rec.digest, payer: rec.payer, amount: rec.amount, amount_usdc: rec.amountUsdc, rate: rec.rate, market: rec.market, score: rec.score, band: rec.band, mode: rec.mode, simulated_via: rec.simulated_via, executed_via: rec.executed_via, verified_via: rec.verified_via, nonce: rec.nonce, memory_blob: rec.memory?.blobId || null, explorer: rec.explorer };
  appendJsonl(LEDGER.results, row);
  appendJsonl(LEDGER.proof, row);
  return row;
}

/** Paid-check history for a payer: Walrus Memory (alibi-agents) first, the local ledger only if Walrus fails (labelled). */
export async function agentHistory(payer, { mem } = {}) {
  if (!payer || !isAddr(payer)) return { count: 0, source: 'none', blobs: [] };
  const who = norm(payer);
  try {
    mem ||= await import('./memory.js');
    const rows = await mem.recall(NS_AGENTS, `ALIBI-AGENTPAY payer=${who}`, { limit: 40 });
    const seen = new Map();
    for (const r of rows) if (r.record?.kind === 'agentpay' && norm(r.record.payer) === who && r.record.digest) seen.set(r.record.digest, r.blobId);
    return { count: seen.size, source: 'walrus', blobs: [...seen.values()] };
  } catch (e) {
    const n = new Set([...readJsonl(LEDGER.results), ...readJsonl(LEDGER.proof)].filter((r) => r.payer && norm(r.payer) === who).map((r) => r.digest)).size;
    return { count: n, source: 'local-ledger (Walrus recall failed)', blobs: [], error: String(e.message).slice(0, 120) };
  }
}

export async function rememberPayment(rec, { mem } = {}) {
  mem ||= await import('./memory.js');
  return mem.remember(NS_AGENTS, 'agentpay', { payer: rec.payer, market: rec.market, score: rec.score, band: rec.band, digest: rec.digest, amount_usdc: rec.amountUsdc, rate: rec.rate, verified_via: rec.verified_via, at: rec.at.slice(0, 16) + 'Z' });
}
