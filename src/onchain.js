// On-chain record check, run inside every market check: read the feed's Pyth PriceInfoObject on Sui through
// Tatum gRPC (~2 calls), then compare it with Pyth itself, both "now" and at the exact second it was published.
import { suiRead, parsePriceInfoJson, readPythPriceInfo } from './sui.js';
import { secret } from './env.js';
import { fetchJson } from './http.js';
import * as pyth from './pyth.js';
import { bps } from './detect.js';

// PriceInfoObjects Alibi created on Sui mainnet on 9 Nov (digests in proof/sui-tx.jsonl).
export const KNOWN_OBJECTS = {
  '765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2': '0xc6b647404252bf4ab0668301d00af86ba6069f12a4b3754a1d73072543d3f2de', // Metal.XAU/USD
  f2fb02c32b055c805e7238d628e5e9dadef274376114eb1f012337cabe93871e: '0x1d7b3e168c236c99c5d598e7e89dce5fcd9729680496a505ebe6f27269088d7a', // Metal.XAG/USD
  a995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b: '0xc9cebd4d723789bb515ac0449080a68fa80d4c1a7e0fdfa2d0eac5fd8fd42d3a', // FX.EUR/USD (created 9 Nov, tx 8TbXu8mQ…)
};
export const SUI_STALE_THRESHOLD_SEC = 60; // stale_price_threshold in the core-compatible Pyth state on Sui

/**
 * Pure comparison. onchain: {price, conf, publishTime}; live: {price, publishTime}; same: price Pyth published at
 * the on-chain publish second (or null). Returns the fields + notes the report prints.
 */
export function compareOnchain({ onchain, live, same, nowSec }) {
  const ageSec = nowSec - onchain.publishTime;
  const out = {
    price: onchain.price,
    conf: onchain.conf,
    confBps: onchain.price ? Math.round((onchain.conf / onchain.price) * 1e4 * 100) / 100 : null,
    publishTime: onchain.publishTime,
    ageMin: Math.round(ageSec / 6) / 10,
    vsLiveBps: live?.price ? Math.round(bps(onchain.price, live.price) * 10) / 10 : null,
    livePublishTime: live?.publishTime ?? null,
    vsSameSecondBps: same?.price ? Math.round(bps(onchain.price, same.price) * 100) / 100 : null,
    notes: [],
  };
  out.status = out.vsSameSecondBps == null ? 'unverified' : Math.abs(out.vsSameSecondBps) <= 0.5 ? 'matches' : 'differs';
  if (ageSec > SUI_STALE_THRESHOLD_SEC) out.notes.push(`On-chain copy is ${out.ageMin} min old: Sui contracts that read it without posting a fresh update first are refused (stale_price_threshold ${SUI_STALE_THRESHOLD_SEC} s) or, with unsafe reads, get a price ${out.ageMin} min old.`);
  if (out.status === 'differs') out.notes.push(`On-chain value differs from what Pyth published at the same second by ${out.vsSameSecondBps} bps.`);
  return out;
}

/** Reads + compares. Never throws; returns { ok:false, error } when Sui or Pyth can't be read. */
export async function onchainRecord(feed, nowSec = Math.floor(Date.now() / 1000)) {
  const hermesId = feed.hermesId.replace(/^0x/, '');
  const res = { feed: feed.symbol, objectId: KNOWN_OBJECTS[hermesId] || null, providers: [], tatumCalls: 0 };
  try {
    let onchain, version;
    if (res.objectId) {
      const o = await suiRead('core.getObject', (c) => c.getObject({ objectId: res.objectId, include: { json: true } }));
      res.providers.push(o.provider); res.tatumCalls += o.provider === 'tatum' ? 1 : 0;
      onchain = parsePriceInfoJson(o.value.object.json);
      version = o.value.object.version;
    } else {
      const r = await readPythPriceInfo(hermesId); // dynamic-field lookup (2–3 calls)
      if (!r.exists) return { ...res, ok: false, error: `no PriceInfoObject for ${feed.symbol} on Sui yet` };
      res.objectId = r.objectId; onchain = r.price; version = r.version; res.providers.push(r.provider);
    }
    const si = await suiRead('ledger.getServiceInfo', async (c) => (await c.ledgerService.getServiceInfo({})).response);
    res.providers.push(si.provider); res.tatumCalls += si.provider === 'tatum' ? 1 : 0;
    res.checkpoint = String(si.value.checkpointHeight ?? '');
    res.epoch = String(si.value.epoch ?? '');
    res.version = String(version);
    // Pyth side: live price (Hermes) and the print at the on-chain publish second (History API).
    let live = null, same = null;
    if (secret('PYTH_API_KEY')) {
      try {
        const r = await fetchJson(`https://hermes.pyth.network/v2/updates/price/latest?ids[]=${hermesId}&parsed=true`, { headers: { authorization: `Bearer ${secret('PYTH_API_KEY')}` } });
        const p = r.parsed?.[0]?.price;
        if (p) live = { price: Number(p.price) * 10 ** p.expo, publishTime: p.publish_time };
      } catch (e) { res.liveError = String(e.message).slice(0, 120); }
      try {
        const prints = await pyth.printsRange(feed.lazerId, onchain.publishTime, onchain.publishTime + 1, feed.channel);
        const exact = prints.filter((x) => Math.floor(x.publishTime) === onchain.publishTime);
        if (exact.length) same = exact.reduce((a, b) => (Math.abs(b.price - onchain.price) < Math.abs(a.price - onchain.price) ? b : a));
      } catch (e) { res.sameError = String(e.message).slice(0, 120); }
    }
    return { ...res, ok: true, ...compareOnchain({ onchain, live, same, nowSec }), provider: res.providers.every((p) => p === 'tatum') ? 'tatum' : res.providers.join('+') };
  } catch (e) {
    return { ...res, ok: false, error: String(e.message).slice(0, 200) };
  }
}

/** The one line the report prints. */
export function onchainLine(o) {
  if (!o) return null;
  if (!o.ok) return `On-chain record (Sui, via Tatum): not read — ${o.error}`;
  const t = new Date(o.publishTime * 1000).toISOString().slice(0, 19).replace('T', ' ') + 'Z';
  const verdict = o.status === 'matches' ? `matches what Pyth published at that second (${o.vsSameSecondBps} bps)` : o.status === 'differs' ? `DIFFERS from what Pyth published at that second by ${o.vsSameSecondBps} bps` : 'same-second Pyth value not available';
  const via = o.provider === 'tatum' ? 'via Tatum' : `via ${o.provider} (public node used on a quota error)`;
  return `On-chain record (Sui, ${via}): price ${+o.price.toPrecision(8)} ± ${+o.conf.toPrecision(3)} at ${t}, ${o.ageMin} min old; ${verdict}; ${o.vsLiveBps == null ? 'live Pyth n/a' : `${o.vsLiveBps > 0 ? '+' : ''}${o.vsLiveBps} bps vs live Pyth`}. Object ${o.objectId} v${o.version}, checkpoint ${o.checkpoint}.`;
}
