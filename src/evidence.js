// Sui evidence: post a signed Pyth update for a feed (create its PriceInfoObject if missing) on Sui mainnet
// through Tatum gRPC, simulate first, cap gas at 0.05 SUI, read it back through Tatum, and log the digest.
// Uses ONLY @pythnetwork/pyth-sui-js/client; Hermes bytes are fetched with plain fetch + bearer key.
import { SuiPythClient } from '@pythnetwork/pyth-sui-js/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Buffer } from 'node:buffer';
import { secret } from './env.js';
import { fetchJson } from './http.js';
import { suiRead, PYTH_SUI, readPythPriceInfo, tatumClientForWrites } from './sui.js';
import { path, appendJsonl, readJsonl } from './store.js';

export const WORMHOLE_STATE = '0xdbca52b9fb4f712e25f61f974586d93ac541bcf8389564f0323bb07215168b5c'; // paired with the core-compatible Pyth state (Pyth docs, contract addresses)
export const GAS_CAP_MIST = 50_000_000n; // 0.05 SUI
export const MAX_REAL_TX = Number(process.env.ALIBI_MAX_SUI_TX || 3);
const TX_LOG = path('results', 'sui-tx.jsonl');

export const realTxCount = () => readJsonl(TX_LOG).filter((r) => r.executed).length;

export function keypair() {
  const k = secret('SUI_PRIVATE_KEY');
  if (!k) throw new Error('SUI_PRIVATE_KEY empty');
  const kp = k.startsWith('suiprivkey') ? Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(k).secretKey) : Ed25519Keypair.fromSecretKey(k);
  const want = secret('SUI_ADDRESS');
  if (want && kp.toSuiAddress() !== want) throw new Error('SUI_PRIVATE_KEY does not match SUI_ADDRESS');
  return kp;
}

/** Signed accumulator update bytes for feeds from Hermes (needs PYTH_API_KEY). */
export async function hermesUpdate(hermesIds) {
  const q = hermesIds.map((id) => `ids[]=${id.replace(/^0x/, '')}`).join('&');
  const r = await fetchJson(`https://hermes.pyth.network/v2/updates/price/latest?${q}&encoding=base64&parsed=true`, { headers: { authorization: `Bearer ${secret('PYTH_API_KEY')}` } });
  return { updates: r.binary.data.map((b) => Buffer.from(b, 'base64')), parsed: r.parsed };
}

const gasOf = (effects) => {
  const g = effects?.gasUsed;
  if (!g) return null;
  return BigInt(g.computationCost) + BigInt(g.storageCost) - BigInt(g.storageRebate);
};

/**
 * Builds the update/create transaction, simulates it, and executes only when execute=true and all checks pass.
 * Returns { action, simulated:{ok, gasMist, error}, digest?, objectId?, readBack? }.
 */
export async function postPythUpdate(hermesId, opts = {}) {
  // Tatum's free plan answers HTTP 429 under bursts: retry the whole build+simulate+execute on Tatum with backoff.
  for (let attempt = 0; ; attempt++) {
    try { return await postOnce(hermesId, opts); }
    catch (e) {
      if (!/429|too many/i.test(String(e.message)) || attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 3000 * 2 ** attempt));
    }
  }
}

async function postOnce(hermesId, { execute = false } = {}) {
  const id = '0x' + hermesId.replace(/^0x/, '');
  const { value: client, provider } = tatumClientForWrites();
  const pyth = new SuiPythClient(client, PYTH_SUI.state, WORMHOLE_STATE);
  const kp = keypair();
  const sender = kp.toSuiAddress();
  const existing = await pyth.getPriceFeedObjectId(id).catch(() => undefined);
  const { updates, parsed } = await hermesUpdate([id]);
  const tx = new Transaction();
  tx.setSender(sender);
  tx.setGasBudget(GAS_CAP_MIST);
  let action;
  if (existing) { await pyth.updatePriceFeeds(tx, updates, [id]); action = 'update'; }
  else { await pyth.createPriceFeed(tx, updates); action = 'create'; }

  const res = { action, feedId: id, provider, existingObjectId: existing || null, hermes: parsed?.[0] ? { price: parsed[0].price.price, expo: parsed[0].price.expo, conf: parsed[0].price.conf, publishTime: parsed[0].price.publish_time } : null };
  const sim = await suiRead('core.simulateTransaction', (c) => c.simulateTransaction({ transaction: tx, include: { effects: true } }));
  const eff = sim.value.Transaction?.effects || sim.value.FailedTransaction?.effects || sim.value.effects;
  const ok = eff?.status?.success ?? !!sim.value.Transaction;
  const gas = gasOf(eff);
  res.simulated = { ok, gasMist: gas?.toString() ?? null, error: ok ? null : JSON.stringify(eff?.status?.error ?? sim.value.FailedTransaction?.status ?? 'unknown').slice(0, 300), provider: sim.provider };
  appendJsonl(TX_LOG, { at: new Date().toISOString(), executed: false, kind: 'simulate', ...res });
  if (!execute) return res;
  if (!ok) throw new Error(`simulation failed: ${res.simulated.error}`);
  if (gas == null || gas > GAS_CAP_MIST) throw new Error(`simulated gas ${gas} exceeds cap ${GAS_CAP_MIST}`);
  if (realTxCount() >= MAX_REAL_TX) throw new Error(`real transaction cap reached (${MAX_REAL_TX})`);

  const ex = await suiRead('core.signAndExecuteTransaction', (c) => c.signAndExecuteTransaction({ transaction: tx, signer: kp, include: { effects: true } }));
  const r = ex.value.Transaction || ex.value.FailedTransaction || ex.value;
  res.digest = r.digest;
  res.executedOk = r.effects?.status?.success ?? !!ex.value.Transaction;
  res.gasMist = gasOf(r.effects)?.toString() ?? null;
  const row = { at: new Date().toISOString(), executed: true, kind: action, digest: res.digest, ok: res.executedOk, gasMist: res.gasMist, feedId: id, provider: ex.provider };
  appendJsonl(TX_LOG, row);
  appendJsonl(path('proof', 'sui-tx.jsonl'), row);
  res.executedVia = ex.provider;
  await suiRead('core.waitForTransaction', (c) => c.waitForTransaction({ digest: res.digest })).catch(() => null);
  res.readBack = await readPythPriceInfo(id);
  res.explorer = `https://suiscan.xyz/mainnet/tx/${res.digest}`;
  return res;
}

/** Evidence record for Walrus (alibi-evidence): the Sui digest plus what was read back through Tatum. */
export function evidenceRecord(symbol, tx, readBack, context) {
  return {
    feed: symbol,
    action: tx.kind || tx.action,
    digest: tx.digest,
    executed_via: tx.provider,
    gas_mist: tx.gasMist,
    object_id: readBack?.objectId,
    object_version: readBack?.version,
    sui_price: readBack?.price ? +readBack.price.price.toPrecision(8) : undefined,
    sui_conf: readBack?.price ? +readBack.price.conf.toPrecision(4) : undefined,
    pyth_publish_time: readBack?.price ? new Date(readBack.price.publishTime * 1000).toISOString() : undefined,
    read_back_via: readBack?.provider,
    explorer: `https://suiscan.xyz/mainnet/tx/${tx.digest}`,
    context,
  };
}
