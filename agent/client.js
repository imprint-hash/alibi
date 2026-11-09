#!/usr/bin/env node
// Demo trading agent: asks Alibi for a settlement check, reads the price from the HTTP 402 answer, pays in USDC on Sui
// from its own wallet (AGENT_SUI_PRIVATE_KEY), retries with X-PAYMENT and prints the report summary and receipt.
// Usage:
//   node agent/client.js --new-wallet                      create the agent wallet in .env (prints the address only)
//   node agent/client.js <polymarket url|slug> [--mode transaction|digest] [--server http://localhost:3000] [--dry-run]
//     transaction (default, x402 "exact" on Sui): signs the transfer and sends it; Alibi simulates, checks, then executes.
//     digest: the agent executes the transfer itself through Tatum and sends the digest + nonce.
//     --dry-run: stop after reading the 402 and simulating the payment (nothing is signed or sent).
import { appendFileSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Transaction, coinWithBalance } from '@mysten/sui/transactions';
import { toBase64 } from '@mysten/sui/utils';
import { loadEnv, secret, ROOT } from '../src/env.js';
import { suiRead, tatumClientForWrites } from '../src/sui.js';
import { path, appendJsonl, readJsonl } from '../src/store.js';
import { USDC, NETWORK, SCHEME, usdc, sameType, b64json } from '../src/pay.js';

loadEnv();
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const ENV = `${ROOT}/.env`;
const GAS_BUDGET = 10_000_000n; // 0.01 SUI, well under the 0.05 SUI cap
export const MAX_PAYMENTS = Number(process.env.ALIBI_MAX_AGENT_PAYMENTS || 3);
const LOG = path('results', 'agent-tx.jsonl');
const log = (...a) => console.log(...a);

if (args.includes('--new-wallet')) {
  if (secret('AGENT_SUI_PRIVATE_KEY')) { log(`agent wallet already exists: ${secret('AGENT_SUI_ADDRESS')}`); process.exit(0); }
  const kp = new Ed25519Keypair();
  const lines = [`AGENT_SUI_PRIVATE_KEY=${kp.getSecretKey()}`, `AGENT_SUI_ADDRESS=${kp.toSuiAddress()}`];
  if (!/^ALIBI_PAY_SECRET=/m.test(readFileSync(ENV, 'utf8'))) lines.push(`ALIBI_PAY_SECRET=${randomBytes(32).toString('hex')}`);
  appendFileSync(ENV, (readFileSync(ENV, 'utf8').endsWith('\n') ? '' : '\n') + lines.join('\n') + '\n');
  log(`created agent wallet ${kp.toSuiAddress()} (key saved to .env, not printed)`);
  process.exit(0);
}

function agentKeypair() {
  const k = secret('AGENT_SUI_PRIVATE_KEY');
  if (!k) throw new Error('AGENT_SUI_PRIVATE_KEY empty: run node agent/client.js --new-wallet');
  const kp = Ed25519Keypair.fromSecretKey(k.startsWith('suiprivkey') ? decodeSuiPrivateKey(k).secretKey : k);
  if (kp.toSuiAddress() !== secret('AGENT_SUI_ADDRESS')) throw new Error('AGENT_SUI_PRIVATE_KEY does not match AGENT_SUI_ADDRESS');
  return kp;
}

/** Payments this agent has signed so far (logged before sending, so a lost response still counts). */
export const paymentsSoFar = () => readJsonl(LOG).filter((r) => r.kind === 'agent-payment' && r.sent).length;

const market = args.find((a) => !a.startsWith('--') && !Object.values({ m: opt('--mode'), s: opt('--server') }).includes(a));
if (!market) { console.error('usage: node agent/client.js <polymarket url|slug> [--mode transaction|digest] [--server URL] [--dry-run]'); process.exit(2); }
const server = opt('--server', process.env.ALIBI_SERVER || 'http://localhost:3000');
const mode = opt('--mode', 'transaction');
const kp = agentKeypair();
const me = kp.toSuiAddress();
const endpoint = `${server}/api/agent/check`;
const body = JSON.stringify({ url: market });

log(`agent ${me}\n→ POST ${endpoint} (no payment)`);
const first = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-payer': me }, body });
if (first.status !== 402) { log(`expected 402, got ${first.status}: ${(await first.text()).slice(0, 300)}`); process.exit(1); }
const required = await first.json();
const req = required.accepts.find((a) => a.scheme === SCHEME && a.network === NETWORK && sameType(a.asset, USDC));
if (!req) { log('no acceptable payment option (need exact / sui:mainnet / USDC)'); process.exit(1); }
const amount = BigInt(req.amount);
log(`← 402 Payment Required: ${usdc(amount)} USDC (${req.extra.rate} rate) to ${req.payTo}, quote expires ${req.extra.expiresAt}`);
if (amount > 100_000n) { log('refusing: price above this agent\'s 0.10 USDC budget'); process.exit(1); }
if (paymentsSoFar() >= MAX_PAYMENTS) { log(`refusing: payment cap reached (${MAX_PAYMENTS})`); process.exit(1); }

// Build the USDC transfer with the Tatum client (coin selection reads go through Tatum), then simulate through Tatum.
const { value: client } = tatumClientForWrites();
const tx = new Transaction();
tx.setSender(me);
tx.setGasBudget(GAS_BUDGET);
tx.transferObjects([coinWithBalance({ type: USDC, balance: amount })], req.payTo);
const bytes = await tx.build({ client });
const sim = await suiRead('core.simulateTransaction', (c) => c.simulateTransaction({ transaction: bytes, include: { balanceChanges: true, effects: true } }));
const st = sim.value.Transaction || sim.value.FailedTransaction;
const toPayee = (st?.balanceChanges || []).filter((b) => sameType(b.coinType, USDC) && b.address === req.payTo).reduce((s, b) => s + BigInt(b.amount), 0n);
const g = st?.effects?.gasUsed;
const gas = g ? BigInt(g.computationCost) + BigInt(g.storageCost) - BigInt(g.storageRebate) : null;
log(`  simulated via ${sim.provider}: ${st?.status?.success ? 'ok' : 'FAILED'}, payee gets ${usdc(toPayee)} USDC, gas ${gas} MIST`);
if (!st?.status?.success || toPayee < amount) process.exit(1);
if (args.includes('--dry-run')) { log('dry run: nothing signed or sent'); process.exit(0); }

let payload, digest;
if (mode === 'digest') {
  appendJsonl(LOG, { at: new Date().toISOString(), kind: 'agent-payment', sent: true, mode, market, amount: String(amount), stage: 'executing' });
  const ex = await suiRead('core.signAndExecuteTransaction', (c) => c.signAndExecuteTransaction({ transaction: bytes, signer: kp, include: { effects: true } }));
  const r = ex.value.Transaction || ex.value.FailedTransaction;
  digest = r.digest;
  log(`  paid on Sui: ${digest} (executed via ${ex.provider}, ${r.status?.success ? 'success' : 'FAILED'})`);
  await suiRead('core.waitForTransaction', (c) => c.waitForTransaction({ digest, timeout: 30_000 })).catch(() => null);
  payload = { digest, nonce: req.extra.nonce };
} else {
  const { signature } = await kp.signTransaction(bytes);
  digest = await Transaction.from(bytes).getDigest();
  appendJsonl(LOG, { at: new Date().toISOString(), kind: 'agent-payment', sent: true, mode, market, amount: String(amount), digest, stage: 'signed, sent to Alibi to settle' });
  payload = { transaction: toBase64(bytes), signature };
}

const header = b64json({ x402Version: 2, resource: required.resource, accepted: req, payload });
log(`→ POST ${endpoint} with X-PAYMENT (${mode} mode)`);
const t0 = Date.now();
const second = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-payment': header, 'x-payer': me }, body });
const out = await second.json().catch(() => ({}));
appendJsonl(LOG, { at: new Date().toISOString(), kind: 'agent-payment-result', mode, market, digest: out.receipt?.digest || digest, status: second.status });
if (second.status !== 200) { log(`← ${second.status}: ${JSON.stringify(out).slice(0, 400)}`); process.exit(1); }
const settle = JSON.parse(Buffer.from(second.headers.get('x-payment-response') || 'e30=', 'base64').toString());
const s = out.summary, r = out.receipt;
log(`← 200 in ${((Date.now() - t0) / 1000).toFixed(1)}s · X-PAYMENT-RESPONSE ${JSON.stringify(settle)}`);
log(`\nREPORT  ${s.market}\n  score ${s.score}/100 (${s.band}) · ${s.verdict}`);
log(`RECEIPT ${r.amountUsdc} USDC (${r.rate}) from ${r.payer}\n  tx ${r.digest}\n  simulated via ${r.simulated_via ?? 'agent'} · executed via ${r.executed_via} · verified via ${r.verified_via}\n  ${r.explorer}`);
log(`AGENT   ${out.agent.note} Next rate: ${out.agent.nextRate}`);
log(`MEMORY  ${r.memory?.blobId ? `Walrus ${r.memory.namespace} blob ${r.memory.blobId}` : `not written (${r.memory?.error})`}`);
