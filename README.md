# Alibi

Checks whether the Pyth price that will settle a Polymarket market can be trusted: it reads the market's own
rules, watches that exact Pyth feed against Hyperliquid, anchors evidence on Sui (via Tatum gRPC) and remembers
every incident in Walrus Memory, so the next warning is sharper. Early-warning and evidence only: it never
predicts or promises how a market or a dispute resolves.

Scope: Polymarket markets settling on Pyth spot gold (Metal.XAU/USD) and silver (Metal.XAG/USD), plus EUR/USD
and USD/JPY. WTI/Brent code paths exist, but our Pyth key is not entitled to commodity futures, and the report says so.

Blog post: [alibi-does-the-price-that-settles-your-b…](https://medium.com/@osagiecynthia517/alibi-does-the-price-that-settles-your-bet-have-an-alibi-ad5bd9aa5b18)

## How to test

1. Open **https://alibi-flame.vercel.app**.
2. Click a **TRY** chip, such as "Gold up or down". A live check takes 1–2 minutes and shows each step: market rules,
   Pyth, Hyperliquid, Sui via Tatum, then Walrus Memory. If you can't wait, click **"Open the saved gold report"**.
3. Click **Show why** to see the 7 checks, the Walrus precedents (blob IDs with Walruscan links), and the on-chain
   Pyth record read through Tatum.
4. Scroll to **Learned**, **Evidence** and **Plans**. Evidence links each Sui transaction to Suiscan. Plans lists
   the real paid agent receipts.
5. Open **/proof** to see the counts read from the `proof/` files: Tatum calls, Walrus writes and Sui transactions.
6. Try the agent paywall:
   `curl -X POST https://alibi-flame.vercel.app/api/agent/check -H 'Content-Type: application/json' -d '{"url":"<polymarket link>"}'`
   returns **HTTP 402** with the x402 payment requirement (0.05 USDC on Sui). For the paid flow, see `agent/client.js`.

```
npm test                         # node --test
node src/cli.js <polymarket url or slug> [--before-after] [--no-ai] [--no-memory] [--json] [--remember]
node src/scan.js --days 10 [--remember --sources]   # real history scan → Walrus incidents
node src/post.js XAU [--execute]                    # Pyth update on Sui (simulate by default, 0.05 SUI cap)
node src/record.js                                  # live recorder (Hyperliquid + Pyth stream)
node src/status.js                                  # keys set/empty + usage counters
```

## Settlement Risk Score (0–100)

Weights live in `src/detect.js` (`WEIGHTS`); the history maths lives in `src/learn.js` (`HISTORY`).

| factor | points | what it measures (live data unless noted) |
|---|---|---|
| divergence | 20 | settlement feed vs Hyperliquid, same field and minute, after removing the rolling basis |
| spikeRevert | 16 | wick past a feed-calibrated threshold (6× median 1-min range, min 15 bps) that comes back within 5 min while the reference stays flat |
| distance | 12 | how close the price is to the market's line, in typical moves (proxy prices count half) |
| repeated | 8 | identical flat prints for 5+ minutes while the venue is open |
| staleness | 8 | missing minutes / publish gaps while open |
| confidence | 8 | Pyth confidence vs its own median |
| thin | 8 | settlement minute and window vs an explicit liquidity table (Alibi heuristic, labelled) |
| **history** | **20** | **Walrus Memory precedents (below)** |

Each factor has a severity 0–1; points = weight × severity. Unmeasured factors are listed, never guessed.

### History factor (memory that changes the product)

- A **precedent** is a remembered incident on the **same Pyth feed** whose time of day (ET) falls in this
  market's **settlement window**: 14 min before to 6 min after the reference candle (e.g. 16:45–17:05 ET around
  the 16:59 ET gold candle).
- Each precedent's weight = min(1, detector severity / 3) × 0.5^(age days / 30); simulated memories count half.
  Incidents on the same feed at other times of day count at 0.15× that weight.
- History severity = 1 − exp(−Σ weights) (saturates; one strong recent precedent ≈ 0.6).
- Memories for other feeds or instruments are ignored and listed with the reason. A user "benign" verdict
  (alibi-user) lowers the matching live factor and halves the history factor.
- When precedents exist the verdict says what they show, from the strongest precedent's pattern (e.g. "Pyth's
  confidence has blown out at this exact minute before"; spikes, divergence, staleness and frozen prints have their own wording),
  and the report's **Precedents** section quotes each one with its date and Walrus blob ID.

Walrus namespaces: `alibi-incidents`, `alibi-sources`, `alibi-evidence`, `alibi-user`. Recall is live from Walrus
mainnet (relayer `relayer.memory.walrus.xyz`); the offline mock is used only in tests. The same event recalled twice
(same feed, pattern and minute) counts once, and the duplicate is listed as ignored. Early writes of source and
evidence records landed in `alibi-incidents` (an SDK namespace quirk, since fixed); they were rewritten to the right
namespaces, and the scorer ignores them by record type.

## Calibration (90-day backtest)

`node src/calibrate.js` samples every trading day of the last 90 days for gold, silver and EUR/USD: the 16:59 ET
settlement candle ±5 minutes (6 minutes a day for metals, which close at 17:00 ET; 11 for EUR/USD) plus a random
sample of ordinary open minutes. Prints come from Pyth fixed_rate@1000ms, candles from the Pyth History API,
divergence from Hyperliquid 5-minute candles (kept ~17 days). Rule: a detector flags at the **p99**, using the higher
of the settlement-window p99 and the ordinary-minute p99, so it fires on at most ~1% of minutes. Full numbers:
`proof/calibration.json`. The history factor re-measures remembered incidents against these thresholds.

| feed | signal | Alibi flags at | what it means (90 days of real Pyth data) |
|---|---|---|---|
| XAU | confidence band | ≥ 23.9× its normal width | 1% of the 378 settlement-window minutes reach it (ordinary minutes: 0% reach it); the 16:59 candle is typically 2.47× |
| XAU | spike | ≥ 16.6 bps from the prior 5-min median | 1% of the 126 ordinary minutes reach it; settlement-window minutes are calmer (their 1%: 8.7) |
| XAU | frozen price | unchanged ≥ 8 s within a minute | 1% of the 378 settlement-window minutes reach it (ordinary minutes: p99 3 s); longest seen 19 s |
| XAU | divergence vs Hyperliquid | ≥ 6.6 bps after basis | 1% of all 3131 5-min bars reach it (around settlement: 5.8 bps), since 2026-10-23 |
| XAU | print gap | ≥ 5 s without a print | never seen: the sampled channel printed every second in all 504 minutes (5 s floor) |
| XAG | confidence band | ≥ 3.11× its normal width | 1% of the 378 settlement-window minutes reach it (ordinary minutes: 0% reach it); the 16:59 candle is typically 1.15× |
| XAG | spike | ≥ 34.7 bps from the prior 5-min median | 1% of the 126 ordinary minutes reach it; settlement-window minutes are calmer (their 1%: 19.6) |
| XAG | frozen price | unchanged ≥ 16 s within a minute | 1% of the 378 settlement-window minutes reach it (ordinary minutes: p99 6 s); longest seen 19 s |
| XAG | divergence vs Hyperliquid | ≥ 10.6 bps after basis | 1% of the 22 5-min bars around settlement reach it (all bars p99 9.2 bps), since 2026-10-23 |
| XAG | print gap | ≥ 5 s without a print | never seen: the sampled channel printed every second in all 504 minutes (5 s floor) |
| EURUSD | confidence band | ≥ 21.02× its normal width | 1% of the 639 settlement-window minutes reach it (ordinary minutes: 0% reach it); the 16:59 candle is typically 2.01× |
| EURUSD | spike | ≥ 4.6 bps from the prior 5-min median | 1% of the 128 ordinary minutes reach it; settlement-window minutes are calmer (their 1%: 3.9) |
| EURUSD | frozen price | unchanged ≥ 46 s within a minute | 1% of the 639 settlement-window minutes reach it (ordinary minutes: p99 34 s); longest seen 59 s |
| EURUSD | divergence vs Hyperliquid | ≥ 4.3 bps after basis | 1% of all 3301 5-min bars reach it (around settlement: 3.9 bps), since 2026-10-23 |
| EURUSD | print gap | ≥ 5 s without a print | never seen: the sampled channel printed every second in all 767 minutes (5 s floor) |

The backtest found **no** settlement-window minute at twice a threshold in 90 days, so it added no new incidents to
Walrus. Gold's 6 Nov 21:55Z blow-out (23.5×) sits right at the 90-day p99 (23.9×): a top-1% event, not a freak.

## Settlement rules Alibi follows (gold, silver, EUR/USD up/down)

- Close = Pyth "Close" of the 1-minute candle timestamped **16:59 ET** (21:59Z in winter, 20:59Z in summer).
- Gold/silver compare with the **most recent prior trading day**: Monday → Friday. A day with an early close
  (for example Thanksgiving, 00:00–14:30 ET) still counts, and its close is the last valid Pyth price before 16:59 ET
  in that session. EUR/USD rules define a **reference day** as a day whose session includes 16:59 ET, so those
  early-close days are skipped.
- An EUR/USD market day is 17:00 ET → 17:00 ET (FX trades around the clock on Pyth); prices after the 16:59 candle
  are never used as the settling price.
- "Hit" markets use the 1-minute High (or Low for ↓) at or beyond the line, from market creation through the window.

## Tatum and Sui: what actually happened

- Every Sui call goes through `suiRead()` in `src/sui.js` with Tatum gRPC (`sui-mainnet-grpc.gateway.tatum.io`) first.
  Each call is counted per method and per provider in `results/tatum-calls.json`, and `node src/status.js` prints the counts.
- A **read** falls back to the public fullnode only when Tatum returns a quota or HTTP 429 error after retries. The
  result is labelled `provider: public-fullnode`. Timeouts and other errors never fall back.
- **Writes never fall back** in the current code.
- **Honest record of the three mainnet transactions** (`results/sui-tx.jsonl`): all three were built and simulated
  through Tatum. **Two of the three executed through the public Sui fullnode, not Tatum**: the XAU and XAG
  PriceInfoObject creates (`EJkydhS1…`, `9H5uqXw8…`). Tatum's free plan returned HTTP 429 at the moment of execution,
  and an earlier version of the code let writes fall back. Only the third transaction, the XAU update `8DDPzvZg…`,
  executed through Tatum. After that, we changed the code so that writes never fall back.
- **Every market check reads Sui through Tatum** (`src/onchain.js`, about 2 calls): the feed's Pyth PriceInfoObject
  (gold `0xc6b6…f2de`, silver `0x1d7b…8d7a`) and Tatum's service info (checkpoint). The report's Evidence section
  prints the on-chain price, confidence, publish time and age, and compares it with Pyth live and with the print Pyth
  published at that same second ("matches" within 0.5 bps). Notes flag a copy older than the Sui contract's 60 s
  stale threshold or a mismatch. Reads only: no transactions. `src/post.js` remains the write path.

## Agent payments (x402 on Sui)

Trading agents pay per Alibi settlement check, in native USDC on Sui mainnet
(`0xdba34672…f900e7::usdc::USDC`, 6 decimals, checked through Tatum `getCoinMetadata`). Price: **0.05 USDC**. An address
with 2 or more paid checks remembered in Walrus Memory pays **0.04 USDC** (the "returning agent" rate).

The format follows the x402 `exact` scheme for Sui
([coinbase/x402 `scheme_exact_sui.md`](https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact_sui.md)) and the
x402 v2 headers ([docs.x402.org, HTTP 402](https://docs.x402.org/core-concepts/http-402)). The protocol is written in
`src/pay.js` with `@mysten/sui` only. No x402 package is installed.

```
GET  /api/agent/price[?payer=0x…]          price, asset, payTo, and the rate for that address
POST /api/agent/check {"url": "<polymarket link or slug>"}
  → 402  body + PAYMENT-REQUIRED header (base64): x402Version 2, accepts[{scheme:"exact", network:"sui:mainnet",
         asset: USDC, amount:"50000", payTo, maxTimeoutSeconds:600, extra:{nonce, issuedAt, expiresAt, rate}}]
  → agent pays, retries with X-PAYMENT (or PAYMENT-SIGNATURE): base64 JSON {x402Version, accepted, payload}
  → 200  {summary, receipt, agent, report} + PAYMENT-RESPONSE / X-PAYMENT-RESPONSE {success, transaction, network, payer}
```

**Two payload modes.**
- `payload: {transaction, signature}` is the spec mode. The agent signs a USDC transfer and does not send it. Alibi
  checks the signature against the tx sender, simulates the tx through Tatum and checks that payTo receives at least
  the quote. Then it runs the check, and only then executes the tx through Tatum. If the check fails, the tx is never
  sent and the agent is not charged.
- `payload: {digest, nonce}` is the pay-first mode. The agent has already executed the transfer. If the check fails,
  the payment is left unused, and the agent can retry with the same header before the quote expires.

**Verification.** Every executed payment is read back with `getTransaction` through **Tatum's Sui gRPC** (`src/sui.js`).
A read falls back to the public node only on a Tatum quota error, and the receipt then says `verified_via:
public-fullnode`. Simulations and executions never fall back. Alibi checks that:
- the tx succeeded;
- the USDC balance change to payTo is at least the quoted amount (other coins and other recipients do not count);
- the sender is recorded as the payer (for a returning-rate quote, it must be the bound address);
- the tx landed between the quote's issue time (30 s skew allowed) and its expiry.

**Quotes and replay protection.**
- **Nonce.** It is an HMAC-signed quote (`v1.issued.expires.random.amount.payer.mac`, key `ALIBI_PAY_SECRET`). The
  amount and the bound payer cannot be changed, and a nonce from another server is refused.
- **Single use.** Each tx digest and each nonce is accepted once. They are stored in
  `results/agent-payments-used.json` and in the `results/` and `proof/` ledgers, and an in-process lock covers
  requests running at the same time. In transaction mode the digest is worked out from the bytes before anything
  runs, because Sui would return the effects of an already-executed tx again.

**Memory.** After each paid check, Alibi writes one Walrus memory to namespace `alibi-agents`:
`ALIBI-AGENTPAY v1 | payer | market | score | band | digest | amount_usdc | rate`. On the next request it recalls
that payer's memories, so the response says "Returning agent: N earlier paid checks". When the agent sends
`X-PAYER`, N also sets its rate.

**Demo agent** (`agent/client.js`, separate wallet `AGENT_SUI_ADDRESS`, funded once from the Alibi wallet by
`agent/fund.js`). It finds the price from the 402, simulates the payment, pays, retries with X-PAYMENT, and prints the
report summary and the receipt. It refuses a price above 0.10 USDC and stops after 3 payments.

```
node agent/client.js <polymarket url|slug> [--mode transaction|digest] [--server http://localhost:3000] [--dry-run]
```

**Real mainnet transactions (9 Nov 2026).** Each was simulated first, and the funding gas cap was 0.05 SUI.

| what | tx | executed via | verified via |
|---|---|---|---|
| fund agent wallet: 0.6 USDC + 0.15 SUI | [`AEiKypmk…MZV`](https://suiscan.xyz/mainnet/tx/AEiKypmk1RMsf2qeTcZd95tdrtZb9TMWbGuVK1JoSMZV) | Tatum | — |
| paid check, gold daily, 0.05 USDC (transaction mode), score 29 | [`9p6bWmUJ…5AnY`](https://suiscan.xyz/mainnet/tx/9p6bWmUJonuJ6Q9ALesXQY9A6RrxTjuMtoyvFeN45AnY) | Tatum (by Alibi) | Tatum |
| paid check, silver weekly, 0.05 USDC (digest mode), score 23 | [`5UMdsmGP…2mxB`](https://suiscan.xyz/mainnet/tx/5UMdsmGPD2pxdbtCRkDwfYozZH2mgnFnHmcixEsX2mxB) | Tatum (by the agent) | Tatum |
| paid check, gold daily, **0.04 USDC returning rate**, score 29 | [`HFVeFEGg…vDoN`](https://suiscan.xyz/mainnet/tx/HFVeFEGgadnbp7WDNKCuaPaSzbXdrkJ2kmaDsDwhvDoN) | Tatum (by Alibi) | Tatum |

Receipts are in `proof/agent-payments.jsonl` and the funding tx is in `proof/agent-tx.jsonl`. The website's Plans card
lists the receipts. Payer and payTo are wallet addresses. They are public on Suiscan, so they appear in these two
files. No keys appear anywhere.

## Security

`.env` and its variants, keys and wallets are git-ignored. The code reports keys only as set/empty, and HTTP errors
redact `key=` query values. A scan of `results/`, `cache/` and `data/` found no secret values.

## Proof files (`proof/`, committed)

`before.json` / `after.json` (same live data, without and with Walrus precedents), `sui-tx.jsonl` (the three mainnet
transactions and their simulations), `memories.jsonl` (every Walrus write: namespace, blob ID, text), `scan-latest.json`
(the 10-day incident scan) and `tatum-calls.json` (Tatum calls per method and provider). They were checked against every
value in `.env`: no keys and no wallet address.
