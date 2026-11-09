# Alibi

Checks whether the Pyth price that will settle a Polymarket market can be trusted: it reads the market's own
rules, watches that exact Pyth feed against Hyperliquid, anchors evidence on Sui (via Tatum gRPC) and remembers
every incident in Walrus Memory, so the next warning is sharper. Early-warning and evidence only: it never
predicts or promises how a market or a dispute resolves.

Scope: Polymarket markets settling on Pyth spot gold (Metal.XAU/USD) and silver (Metal.XAG/USD); EUR/USD as a
bonus. WTI/Brent code paths exist, but our Pyth key is not entitled to commodity futures, and the report says so.

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

## Security

`.env` and its variants, keys and wallets are git-ignored. The code reports keys only as set/empty, and HTTP errors
redact `key=` query values. A scan of `results/`, `cache/` and `data/` found no secret values.

## Proof files (`proof/`, committed)

`before.json` / `after.json` (same live data, without and with Walrus precedents), `sui-tx.jsonl` (the three mainnet
transactions and their simulations), `memories.jsonl` (every Walrus write: namespace, blob ID, text), `scan-latest.json`
(the 10-day incident scan) and `tatum-calls.json` (Tatum calls per method and provider). They were checked against every
value in `.env`: no keys and no wallet address.
