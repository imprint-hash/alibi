// Tatum Data APIs for Alibi. Checked against Sui mainnet on 9 Nov 2026 (evidence: proof/tatum-data-support.json):
//   - Exchange rates  (GET /v4/data/rate/symbol): WORKS for SUI and USDC → rates() prices our evidence posts in USD.
//   - Transaction history (GET /v4/data/transaction/history): NOT supported for Sui (400, chain enum has no Sui).
//   - Notifications / webhooks (POST /v4/subscription): NOT supported for Sui (400, attr.chain enum has no Sui).
// Because the Data API can't list Sui history, listEvidenceTxs() reads Alibi's evidence transactions through
// Tatum's Sui gRPC (getTransaction by digest) and says so in its output.
import { secret } from './env.js';
import { fetchJson, HttpError } from './http.js';
import { bump, path, readJson, readJsonl, writeJson } from './store.js';
import { suiRead } from './sui.js';

const API = 'https://api.tatum.io';
const COUNTER = path('results', 'tatum-calls.json');
const RATE_CACHE = path('cache', 'tatum-rates.json');
const RATE_TTL_MS = 5 * 60 * 1000;

async function tatumData(method, url, opts = {}) {
  const key = secret('TATUM_API_KEY');
  if (!key) throw new Error('TATUM_API_KEY empty');
  try {
    const r = await fetchJson(url, { ...opts, headers: { 'x-api-key': key, 'content-type': 'application/json', ...(opts.headers || {}) }, minGapMs: 400, retries: 2 });
    bump(COUNTER, `tatum:data.${method}`);
    return r;
  } catch (e) {
    bump(COUNTER, `tatum:data.${method}:error`);
    throw e;
  }
}

/** SUI/USD and USDC/USD from Tatum's exchange-rate API (cached 5 min). */
export async function rates({ refresh = false } = {}) {
  const c = readJson(RATE_CACHE, null);
  if (!refresh && c && Date.now() - c.fetchedAt < RATE_TTL_MS) return { ...c, cached: true };
  const out = { fetchedAt: Date.now(), via: 'Tatum Data API /v4/data/rate/symbol' };
  for (const sym of ['SUI', 'USDC']) {
    const r = await tatumData('rate', `${API}/v4/data/rate/symbol?symbol=${sym}&basePair=USD`);
    out[sym] = { usd: Number(r.value), source: r.source, timestamp: r.timestamp };
  }
  writeJson(RATE_CACHE, out);
  return { ...out, cached: false };
}

/** Dollar cost of a gas amount in MIST. Pure. */
export function mistToUsd(mist, suiUsd) {
  const sui = Number(mist) / 1e9;
  return { sui: Math.round(sui * 1e6) / 1e6, usd: Number.isFinite(suiUsd) ? Math.round(sui * suiUsd * 1e5) / 1e5 : null };
}

/**
 * Alibi's executed evidence transactions, each read back through Tatum's Sui gRPC (status, checkpoint, gas),
 * priced in USD with Tatum rates. Writes a proof snapshot to proof/evidence-tatum.json.
 */
export async function listEvidenceTxs({ snapshot = true } = {}) {
  const logged = readJsonl(path('results', 'sui-tx.jsonl')).filter((t) => t.executed && t.digest);
  const r = await rates().catch(() => null);
  const suiUsd = r?.SUI?.usd;
  const txs = [];
  for (const t of logged) {
    const row = { digest: t.digest, kind: t.kind, feedId: t.feedId, executedVia: t.provider, loggedAt: t.at, explorer: `https://suiscan.xyz/mainnet/tx/${t.digest}` };
    try {
      const g = await suiRead('core.getTransaction', (c) => c.getTransaction({ digest: t.digest, include: { effects: true } }));
      const tx = g.value.Transaction || g.value.FailedTransaction || g.value;
      const eff = tx.effects;
      const gas = eff?.gasUsed ? BigInt(eff.gasUsed.computationCost) + BigInt(eff.gasUsed.storageCost) - BigInt(eff.gasUsed.storageRebate) : null;
      Object.assign(row, { readVia: g.provider, success: eff?.status?.success ?? null, gasMist: gas?.toString() ?? t.gasMist ?? null, ...(gas != null ? { cost: mistToUsd(gas, suiUsd) } : {}) });
    } catch (e) {
      row.readError = String(e.message).slice(0, 120);
    }
    txs.push(row);
  }
  const out = {
    generatedAt: new Date().toISOString(),
    source: 'Tatum Sui gRPC getTransaction per digest (Tatum Data API transaction history does not support Sui; see proof/tatum-data-support.json)',
    rates: r ? { SUI_USD: r.SUI?.usd, USDC_USD: r.USDC?.usd, source: r.SUI?.source, via: r.via } : null,
    totalGasSui: Math.round(txs.reduce((a, x) => a + (Number(x.gasMist) || 0), 0) / 1e3) / 1e6,
    totalUsd: suiUsd ? Math.round((txs.reduce((a, x) => a + (Number(x.gasMist) || 0), 0) / 1e9) * suiUsd * 1e4) / 1e4 : null,
    txs,
  };
  if (snapshot) writeJson(path('proof', 'evidence-tatum.json'), out);
  return out;
}

/** Re-runs the Sui support check for the three Data APIs and records the evidence (no secrets, wallet masked). */
export async function checkSuiSupport() {
  const addr = secret('SUI_ADDRESS') || '0x0';
  const mask = (s) => String(s).split(addr).join('<alibi-wallet>');
  const res = { checkedAt: new Date().toISOString(), chain: 'sui-mainnet', apis: {} };
  const probe = async (name, method, url, opts) => {
    try { const r = await tatumData(method, url, opts); res.apis[name] = { supported: true, http: 200, sample: JSON.parse(mask(JSON.stringify(r))) }; }
    catch (e) {
      const body = e instanceof HttpError ? String(e.body) : String(e.message);
      const enumList = (body.match(/must be one of the following values: ([^"\]]+)/) || [])[1];
      res.apis[name] = { supported: false, http: e.status ?? null, reason: mask(body).slice(0, 200), suiInAllowedChains: enumList ? /sui/i.test(enumList) : null, allowedChains: enumList ? enumList.split(',').map((s) => s.trim()).slice(0, 80) : undefined };
    }
  };
  await probe('exchangeRate.SUI', 'rate', `${API}/v4/data/rate/symbol?symbol=SUI&basePair=USD`);
  await probe('exchangeRate.USDC', 'rate', `${API}/v4/data/rate/symbol?symbol=USDC&basePair=USD`);
  await probe('transactionHistory', 'txHistory', `${API}/v4/data/transaction/history?chain=sui-mainnet&addresses=${addr}`);
  await probe('notifications.addressEvent', 'subscription', `${API}/v4/subscription?type=mainnet`, { method: 'POST', body: JSON.stringify({ type: 'ADDRESS_EVENT', attr: { chain: 'sui-mainnet', address: addr, url: 'https://example.com/alibi-webhook' } }) });
  writeJson(path('proof', 'tatum-data-support.json'), res);
  return res;
}
