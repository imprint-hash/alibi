#!/usr/bin/env node
// One-off: fund the demo agent wallet from the Alibi wallet (SUI_PRIVATE_KEY) with USDC + SUI for gas.
// Through Tatum only: build, simulate, gas cap 0.05 SUI, execute; writes never fall back to the public node.
// Refuses if a funding tx is already logged. On an object-version conflict (the Pyth poster shares this wallet's gas
// coin) it re-reads the coins, rebuilds and retries, but only after confirming the first attempt did not land.
// Usage: node agent/fund.js [--usdc 0.6] [--sui 0.15] [--execute]
import { Transaction, coinWithBalance } from '@mysten/sui/transactions';
import { loadEnv, secret } from '../src/env.js';
import { suiRead, tatumClientForWrites, balances } from '../src/sui.js';
import { keypair } from '../src/evidence.js';
import { path, appendJsonl, readJsonl } from '../src/store.js';
import { USDC, usdc, sameType } from '../src/pay.js';

loadEnv();
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const USDC_AMT = BigInt(Math.round(Number(opt('--usdc', '0.6')) * 1e6));
const SUI_AMT = BigInt(Math.round(Number(opt('--sui', '0.15')) * 1e9));
const GAS_CAP = 50_000_000n;
if (USDC_AMT > 600_000n || SUI_AMT > 150_000_000n) { console.error('refusing: above the approved 0.6 USDC + 0.15 SUI'); process.exit(1); }
const LOG = path('results', 'agent-tx.jsonl');
const to = secret('AGENT_SUI_ADDRESS');
if (!to) { console.error('AGENT_SUI_ADDRESS empty: run node agent/client.js --new-wallet'); process.exit(1); }
const already = [...readJsonl(LOG), ...readJsonl(path('results', 'sui-tx.jsonl'))].find((r) => r.kind === 'agent-fund' && r.executed);
if (already) { console.log(`already funded: ${already.digest}; not sending again`); process.exit(0); }

const kp = keypair();
const agentUsdc = async () => { const b = await balances(to); return BigInt(b.value.balances.find((x) => sameType(x.coinType, USDC))?.balance || 0); };
const gasOf = (e) => (e?.gasUsed ? BigInt(e.gasUsed.computationCost) + BigInt(e.gasUsed.storageCost) - BigInt(e.gasUsed.storageRebate) : null);

async function buildAndSimulate() {
  const { value: client } = tatumClientForWrites();
  const tx = new Transaction();
  tx.setSender(kp.toSuiAddress());
  tx.setGasBudget(GAS_CAP);
  const [sui] = tx.splitCoins(tx.gas, [SUI_AMT]);
  tx.transferObjects([coinWithBalance({ type: USDC, balance: USDC_AMT }), sui], to);
  const bytes = await tx.build({ client }); // fresh coin versions every time
  const sim = await suiRead('core.simulateTransaction', (c) => c.simulateTransaction({ transaction: bytes, include: { effects: true, balanceChanges: true } }));
  const t = sim.value.Transaction || sim.value.FailedTransaction;
  const gas = gasOf(t?.effects);
  const got = (t?.balanceChanges || []).filter((b) => b.address === to);
  const row = { at: new Date().toISOString(), executed: false, kind: 'agent-fund-simulate', ok: !!t?.status?.success, gasMist: gas?.toString() ?? null, provider: sim.provider, to_usdc: usdc(USDC_AMT), to_sui: (Number(SUI_AMT) / 1e9).toString() };
  appendJsonl(LOG, row);
  console.log(`simulated via ${sim.provider}: ${row.ok ? 'ok' : 'FAILED ' + JSON.stringify(t?.status?.error).slice(0, 200)}, gas ${gas} MIST, agent receives ${got.map((b) => `${b.amount} ${b.coinType.split('::').pop()}`).join(' + ')}`);
  if (!row.ok) throw new Error('simulation failed');
  if (gas == null || gas > GAS_CAP) throw new Error(`gas ${gas} above cap`);
  return bytes;
}

let bytes = await buildAndSimulate();
if (!args.includes('--execute')) { console.log('simulation only; add --execute to send'); process.exit(0); }
const before = await agentUsdc();
for (let attempt = 0; attempt < 2; attempt++) {
  try {
    const ex = await suiRead('core.signAndExecuteTransaction', (c) => c.signAndExecuteTransaction({ transaction: bytes, signer: kp, include: { effects: true } }));
    const r = ex.value.Transaction || ex.value.FailedTransaction;
    const row = { at: new Date().toISOString(), executed: true, kind: 'agent-fund', digest: r.digest, ok: !!r.status?.success, gasMist: gasOf(r.effects)?.toString() ?? null, provider: ex.provider, to_usdc: usdc(USDC_AMT), to_sui: (Number(SUI_AMT) / 1e9).toString() };
    appendJsonl(LOG, row);
    appendJsonl(path('proof', 'agent-tx.jsonl'), { ...row, to });
    console.log(`funded: ${row.digest} via ${row.provider} ok=${row.ok} gas=${row.gasMist} MIST\nhttps://suiscan.xyz/mainnet/tx/${row.digest}`);
    process.exit(row.ok ? 0 : 1);
  } catch (e) {
    const msg = String(e?.message || e);
    console.log(`execute error: ${msg.slice(0, 200)}`);
    if (attempt > 0 || !/version|unavailable|locked|equivocat|conflict|not available for consumption/i.test(msg)) process.exit(1);
    await new Promise((ok) => setTimeout(ok, 4000));
    if ((await agentUsdc()) > before) { console.log('the first attempt landed after all; not resending'); process.exit(0); }
    console.log('object version conflict: re-reading coins and rebuilding');
    bytes = await buildAndSimulate();
  }
}
