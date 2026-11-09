// Sui reads through Tatum gRPC (primary) with the public fullnode as a quota-only fallback.
// Every read is counted per method and per provider in results/tatum-calls.json.
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { GrpcTransport } from '@protobuf-ts/grpc-transport';
import { ChannelCredentials } from '@grpc/grpc-js';
import { secret } from './env.js';
import { bump, path, readJson } from './store.js';

export const TATUM_HOST = 'sui-mainnet-grpc.gateway.tatum.io:443';
export const PUBLIC_FULLNODE = 'https://fullnode.mainnet.sui.io:443';
export const PYTH_SUI = {
  state: '0x03719fae774ddab3cfcaa53bbc046f0cbe21410019b6280811bf3f9f4b05839d',
  package: '0x55300367a2d40813727ccac4ecee977a39fb9cdb46f2e6b2c354b9798f5de2c0',
  priceTable: '0x34188088689963c36b11a2309c8dc871afd806194b06466999d6cc6a2b34afec',
};
const COUNTER = path('results', 'tatum-calls.json');

let tatum, pub;
function tatumClient() {
  const key = secret('TATUM_API_KEY');
  if (!key) return null;
  if (!tatum) {
    const transport = new GrpcTransport({
      host: TATUM_HOST,
      channelCredentials: ChannelCredentials.createSsl(),
      meta: { 'x-api-key': key },
    });
    tatum = new SuiGrpcClient({ network: 'mainnet', transport });
  }
  return tatum;
}
function publicClient() {
  if (!pub) pub = new SuiGrpcClient({ network: 'mainnet', baseUrl: PUBLIC_FULLNODE });
  return pub;
}

/**
 * True when an error is a Tatum quota / rate / plan limit (the only case where a read may fall back).
 * Timeouts ("deadline exceeded"), not-found and other errors are NOT quota errors and never fall back.
 */
export function isQuotaError(e) {
  const code = e?.code;
  const msg = String(e?.message || e || '').toLowerCase();
  return code === 'RESOURCE_EXHAUSTED' || code === 8 || /quota|rate limit|too many requests|out of credits|credit limit|payment required|status code (429|402)\b|\bhttp (429|402)\b/.test(msg);
}

const WRITE_METHODS = /signAndExecute|executeTransaction|simulateTransaction/; // writes (and their simulations) never fall back
let lastTatum = 0;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
/** HTTP 429 from Tatum is a per-second rate limit, not an exhausted plan: wait and retry on Tatum first. */
export const isRateLimit = (e) => /status code 429\b|\bhttp 429\b|too many requests/i.test(String(e?.message || e));

/**
 * Runs one Sui call through Tatum. `fn(client)` gets a SuiGrpcClient. Returns { value, provider }.
 * Reads fall back to the public fullnode only on quota errors (provider says so); writes never fall back.
 */
export async function suiRead(method, fn) {
  const t = tatumClient();
  const isWrite = WRITE_METHODS.test(method);
  if (t) {
    for (let attempt = 0; ; attempt++) {
      const wait = lastTatum + 350 - Date.now(); // keep under the free plan's per-second limit
      if (wait > 0) await pause(wait);
      lastTatum = Date.now();
      try {
        const value = await fn(t);
        bump(COUNTER, `tatum:${method}`);
        return { value, provider: 'tatum' };
      } catch (e) {
        const quota = isQuotaError(e);
        bump(COUNTER, `tatum:${method}:${quota ? 'quota-error' : 'error'}`, 1, () => ({
          _lastError: { method, code: e?.code ?? null, quota, message: String(e?.message || e).slice(0, 160), at: new Date().toISOString() },
        }));
        if (isRateLimit(e) && attempt < 4) { await pause(1500 * 2 ** attempt); continue; }
        if (!quota || isWrite) throw e; // writes never fall back silently
        break;
      }
    }
  }
  const value = await fn(publicClient());
  bump(COUNTER, `public:${method}`);
  return { value, provider: 'public-fullnode' };
}

export function callCounts() {
  const c = readJson(COUNTER, {});
  const tatumTotal = Object.entries(c).filter(([k]) => k.startsWith('tatum:')).reduce((a, [, v]) => a + v, 0);
  return { ...c, tatumTotal };
}

export const serviceInfo = () => suiRead('ledger.getServiceInfo', async (c) => (await c.ledgerService.getServiceInfo({})).response);

export const balances = (owner) => suiRead('core.listBalances', (c) => c.listBalances({ owner }));

const hexToBytes = (h) => Uint8Array.from(h.replace(/^0x/, '').match(/../g).map((b) => parseInt(b, 16)));

/** PriceIdentifier BCS: vector<u8> → ULEB length (0x20) + 32 bytes. */
export function priceIdentifierBcs(feedIdHex) {
  const id = hexToBytes(feedIdHex);
  if (id.length !== 32) throw new Error('feed id must be 32 bytes');
  return Uint8Array.from([0x20, ...id]);
}

let priceIdType;
async function priceIdentifierType() {
  if (priceIdType) return priceIdType;
  // Learn the exact key type from one table entry instead of guessing the original package id.
  const { value } = await suiRead('core.listDynamicFields', (c) => c.listDynamicFields({ parentId: PYTH_SUI.priceTable, limit: 1 }));
  const f = value.dynamicFields?.[0];
  priceIdType = f?.name?.type || `${PYTH_SUI.package}::price_identifier::PriceIdentifier`;
  return priceIdType;
}

/**
 * Finds the PriceInfoObject for a Pyth feed on Sui and returns its parsed price.
 * Returns { exists:false } when Sui has no object for that feed (e.g. WTI today).
 */
export async function readPythPriceInfo(feedIdHex) {
  const type = await priceIdentifierType();
  let field;
  try {
    const r = await suiRead('core.getDynamicField', (c) => c.getDynamicField({ parentId: PYTH_SUI.priceTable, name: { type, bcs: priceIdentifierBcs(feedIdHex) } }));
    field = r.value.dynamicField;
  } catch (e) {
    if (/not ?found|does not exist|NOT_FOUND/i.test(String(e?.message || e))) return { exists: false, feedId: feedIdHex };
    throw e;
  }
  // value is an object ID (32 bytes)
  const raw = field.value?.bcs;
  const objectId = '0x' + Buffer.from(raw).toString('hex');
  const o = await suiRead('core.getObject', (c) => c.getObject({ objectId, include: { json: true } }));
  const json = o.value.object.json;
  return { exists: true, feedId: feedIdHex, objectId, version: o.value.object.version, provider: o.provider, price: parsePriceInfoJson(json) };
}

/** Pulls price/conf/expo/timestamp out of the PriceInfoObject JSON shape (shape varies by API). */
export function parsePriceInfoJson(json) {
  const pf = json?.price_info?.price_feed || json?.price_info?.fields?.price_feed?.fields;
  const p = pf?.price?.fields || pf?.price;
  if (!p) return null;
  const i64 = (x) => {
    const v = x?.fields || x;
    if (v == null) return null;
    if (typeof v === 'object' && 'negative' in v) return (v.negative ? -1 : 1) * Number(v.magnitude);
    return Number(v);
  };
  const expo = i64(p.expo);
  const price = i64(p.price) * 10 ** expo;
  const conf = Number(p.conf) * 10 ** expo;
  return { price, conf, expo, publishTime: Number(p.timestamp), attestationTime: Number(json?.price_info?.attestation_time || 0) };
}

/** The Tatum client (for building/simulating/executing). Writes never fall back silently; reads do via suiRead. */
export function tatumClientForWrites() {
  const t = tatumClient();
  if (!t) throw new Error('TATUM_API_KEY empty');
  // count every .core call made by libraries (e.g. SuiPythClient) through this client
  const counted = new Proxy(t, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (prop !== 'core') return typeof v === 'function' ? v.bind(target) : v;
      return new Proxy(v, { get(core, m) { const f = Reflect.get(core, m); return typeof f === 'function' ? (...a) => { bump(COUNTER, `tatum:pyth-sui:${String(m)}`); return f.apply(core, a); } : f; } });
    },
  });
  return { value: counted, provider: 'tatum' };
}
