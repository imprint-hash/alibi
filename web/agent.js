// Agent micro-API: POST /api/agent/check (x402-style paywall, USDC on Sui) and GET /api/agent/price.
// Shared by server.js and the Vercel functions in api/agent/. Protocol and verification live in src/pay.js.
import { runLive, marketKey, normalizeInput } from './live.js';
import { clientIp } from './handler.js';
import * as pay from '../src/pay.js';

// Wallet addresses are public (they are on every receipt and on Suiscan); keys and other secrets are still removed.
const SECRET = /KEY|SECRET|TOKEN|PRIVATE|PASSWORD|MNEMONIC|ACCOUNT_ID/i;
const redact = (s) => { for (const [k, v] of Object.entries(process.env)) if (SECRET.test(k) && !/_ADDRESS$/.test(k) && v && v.length >= 8) s = s.split(v).join('***'); return s; };
const send = (res, code, body, extra = {}) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'access-control-expose-headers': 'PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE', ...extra });
  res.end(redact(JSON.stringify(body)));
};

async function readBody(req) {
  try {
    if (req.body !== undefined) return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    let s = '';
    for await (const c of req) { s += c; if (s.length > 4096) break; }
    return JSON.parse(s || '{}');
  } catch { return {}; }
}

const resourceUrl = (req) => `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['x-forwarded-host'] || req.headers.host || 'localhost'}/api/agent/check`;
const payerHint = (req, body) => { const p = String(req.headers['x-payer'] || body?.payer || ''); return /^0x[0-9a-fA-F]{64}$/.test(p) ? p : null; };

async function quote(req, body, error) {
  const payer = payerHint(req, body);
  const history = payer ? await pay.agentHistory(payer) : null;
  return pay.paymentRequired({ resourceUrl: resourceUrl(req), payer, history, error });
}
async function send402(res, req, body, error) {
  const q = await quote(req, body, error);
  return send(res, 402, q, { 'payment-required': pay.b64json(q) });
}

/** GET /api/agent/price: what a check costs, without a nonce. Add ?payer=0x… to see the rate for that address. */
export async function handleAgentPrice(req, res) {
  try {
    const u = new URL(req.url, 'http://x');
    const payer = /^0x[0-9a-fA-F]{64}$/.test(u.searchParams.get('payer') || '') ? u.searchParams.get('payer') : null;
    const history = payer ? await pay.agentHistory(payer) : null;
    const returning = !!(history && history.count >= pay.PRICE.returningAfter);
    send(res, 200, {
      endpoint: 'POST /api/agent/check {"url": "<polymarket link or slug>"}',
      scheme: pay.SCHEME, network: pay.NETWORK, asset: pay.USDC, decimals: pay.USDC_DECIMALS, payTo: pay.payTo(),
      amount: String(pay.PRICE.standard), priceUsdc: pay.usdc(pay.PRICE.standard),
      returningRate: { amount: String(pay.PRICE.returning), priceUsdc: pay.usdc(pay.PRICE.returning), after: `${pay.PRICE.returningAfter} paid checks remembered in Walrus Memory (${pay.NS_AGENTS}); send X-PAYER: <your address>, the quote is then bound to that address` },
      ...(payer ? { payer, priorPaidChecks: history.count, historySource: history.source, rate: returning ? 'returning' : 'standard' } : {}),
      quoteValidSeconds: pay.TIMEOUT_S,
      headers: { request: ['PAYMENT-SIGNATURE', 'X-PAYMENT'], response: ['PAYMENT-REQUIRED', 'PAYMENT-RESPONSE', 'X-PAYMENT-RESPONSE'] },
      spec: 'https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact_sui.md',
    }, { 'cache-control': 'public, max-age=30' });
  } catch (e) { send(res, e.status || 500, { error: e.message }); }
}

/**
 * POST /api/agent/check {url}. No payment → 402 PaymentRequired. With PAYMENT-SIGNATURE / X-PAYMENT → verify through
 * Tatum, run the check, settle (transaction mode) and return {report, receipt, agent}. In transaction mode the agent is
 * charged only after the check succeeds; in digest mode a failed check leaves the payment unused (retry before expiry).
 */
export async function handleAgentCheck(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST {"url": "<polymarket link>"}' }, { allow: 'POST' });
  const body = await readBody(req);
  const input = normalizeInput(body?.url);
  const key = marketKey(input);
  if (!key) return send(res, 400, { error: 'Send {"url": "<polymarket.com market link or slug>"}. You are not charged for a bad request.' });

  let parsed;
  try {
    const raw = pay.paymentHeader(req.headers);
    if (!raw) return await send402(res, req, body, 'X-PAYMENT header is required');
    parsed = pay.parsePayment(raw);
  } catch (e) {
    return e instanceof pay.PayError ? send402(res, req, body, `${e.code}: ${e.message}`) : send(res, 500, { error: 'payment parsing failed' });
  }

  let v, unlock = () => {};
  try {
    v = await pay.verifyPayment(parsed);
    unlock = pay.lock([`d:${v.digest}`, `n:${parsed.nonce}`]);
  } catch (e) {
    if (e instanceof pay.PayError) return e.status === 402 ? send402(res, req, body, `${e.code}: ${e.message}`) : send(res, e.status, { error: e.message });
    return send(res, 502, { error: `could not verify the payment on Sui: ${String(e.message).slice(0, 160)}` });
  }

  try {
    let report;
    try {
      report = await runLive(input.startsWith('http') ? input : key, key, () => {});
    } catch (e) {
      const charged = v.mode === 'digest';
      return send(res, e.status || 502, { error: `The check could not run: ${String(e.message).slice(0, 160)}`, charged: false, note: charged ? 'Your payment was verified but not consumed; retry with the same X-PAYMENT before the quote expires.' : 'Your signed transaction was not executed.' });
    }
    let done;
    try { done = await v.settle(); }
    catch (e) { return send402(res, req, body, `${e.code || 'settle_failed'}: ${String(e.message).slice(0, 160)}`); }
    pay.markUsed({ digest: done.digest, nonce: parsed.nonce }); // consumed before anything else can fail

    const market = report.market?.question || key;
    const history = await pay.agentHistory(done.payer);
    const rec = pay.receipt(done, { market: key, score: report.score ?? null, band: report.band ?? null });
    let memory;
    try { const w = await pay.rememberPayment(rec); memory = { namespace: pay.NS_AGENTS, blobId: w.blobId, backend: w.backend }; }
    catch (e) { memory = { namespace: pay.NS_AGENTS, error: String(e.message).slice(0, 120) }; }
    rec.memory = memory;
    pay.recordPayment(rec);
    const settlement = { success: true, transaction: done.digest, network: pay.NETWORK, payer: done.payer };
    const agent = {
      payer: done.payer, priorPaidChecks: history.count, historySource: history.source, returning: history.count > 0,
      note: history.count > 0 ? `Returning agent: ${history.count} earlier paid check(s) remembered in Walrus Memory (${pay.NS_AGENTS}).` : 'First paid check from this address.',
      nextRate: history.count + 1 >= pay.PRICE.returningAfter ? `returning (${pay.usdc(pay.PRICE.returning)} USDC; send X-PAYER to get it)` : `standard (${pay.usdc(pay.PRICE.standard)} USDC)`,
    };
    return send(res, 200, { summary: { market, slug: key, score: report.score ?? null, band: report.band ?? null, verdict: report.verdict, kind: report.kind, source: report.source }, receipt: rec, agent, report },
      { 'payment-response': pay.b64json(settlement), 'x-payment-response': pay.b64json(settlement) });
  } finally { unlock(); }
}
