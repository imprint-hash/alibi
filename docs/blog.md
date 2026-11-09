# Alibi: does the price that settles your bet have an alibi?

### A settlement-price checker for Pyth-settled Polymarket markets that reads Sui through Tatum and remembers every incident in Walrus Memory

<!-- Sources for every number in this post:
     results/before-after.txt == proof/before.json + proof/after.json (live gold check, 9 Nov 2026)
     proof/memories.jsonl (32 Walrus writes, blob IDs, incident texts)
     proof/scan-latest.json (10-day scan: incident counts per feed, calibration)
     proof/sui-tx.jsonl (3 mainnet txs + 4 simulations, provider per tx)
     proof/tatum-calls.json (Tatum call counts; snapshot 2026-11-09T12:09Z)
     README.md (score weights, precedent window, Tatum/Sui honest record) -->

## The problem

A prediction market can be right about the world and still settle on a bad number. Polymarket's daily gold, silver and EUR/USD markets settle on one Pyth feed at one minute: the Close of the 1-minute candle stamped 16:59 ET. If that one print is wide, stale or briefly off, the market settles on it anyway. Traders can read the question. Almost nobody reads the settlement rule, and nobody checks how that feed behaved at that minute on earlier days.

## What Alibi does

Paste a Polymarket link. Alibi reads the market's rules, finds the exact feed, field and minute that will settle it, and checks that feed against Hyperliquid. It reads the on-chain price on Sui through Tatum and recalls past incidents from Walrus Memory. You get a Settlement Risk Score from 0 to 100, three plain sentences and the evidence.

Alibi is an early-warning and evidence tool. It never predicts how a market resolves and never promises a dispute outcome.

**A real example.** On 9 Nov 2026 we checked "Gold (XAUUSD) Up or Down on November 9?" (Up 0.83 / Down 0.17). Alibi read the rule: Close of Pyth `Metal.XAU/USD` at the 21:59Z candle (16:59 ET), compared with the prior trading day's close, 6 Nov. Live data gave three points of concern:
<!-- src: results/before-after.txt "Why this score" -->

- **+6.5 thin hours:** 54% of the open window is outside core liquidity.
- **+6.4 confidence:** Pyth's confidence interval was 8× its normal width (3.3 bps).
- **+4.6 distance:** the price sat +93.9 bps from the $4,070.442 line.

## How Alibi uses Tatum

Every Sui call goes through one function, `suiRead()`, which uses Tatum's Sui gRPC gateway (`sui-mainnet-grpc.gateway.tatum.io`) first. Each call is counted per method and per provider.

- **On every check**, Alibi reads the feed's Pyth `PriceInfoObject` on Sui and Tatum's service info (the latest checkpoint) through Tatum. In the gold check, the on-chain copy was 4,100.969 ± 0.32, published 07:28:11Z, at checkpoint 343353304. It matched Pyth exactly, but it was 280.7 minutes old, far past the Sui contract's 60-second stale threshold. Alibi says so in the report.
<!-- src: results/before-after.txt "Evidence" -->
- **Posting evidence to Sui.** No gold or silver `PriceInfoObject` existed on Sui's Pyth contract, so Alibi created both and then posted a fresh gold update. Every transaction was simulated through Tatum first (4 simulations).
<!-- src: proof/sui-tx.jsonl; proof/tatum-calls.json "tatum:core.simulateTransaction": 4 -->
- **Data APIs:** TODO(data-api): fill in which Tatum Data API endpoints the engine calls, and for what, once confirmed.

At the snapshot time, Alibi had made 57 Tatum gRPC calls across 12 methods, plus 5 public-node fallback calls.
<!-- src: proof/tatum-calls.json (tatum:* keys summed = 57, incl. 7 errors; public:* = 5). Refresh before publishing. -->

## How Alibi uses Walrus Memory

Alibi writes to Walrus Memory on mainnet through the relayer, in four namespaces:

- `alibi-incidents`: each incident found in real Pyth history, as one structured line (feed, pattern, size, minute, publishers, a Pyth chart link).
- `alibi-sources`: per-feed facts, such as the normal confidence width at the close and the spike threshold.
- `alibi-evidence`: each Sui transaction with its digest, object, price and provider.
- `alibi-user`: a user's "this was benign" verdict, which lowers the matching factor.

So far there are 32 mainnet writes: 14 incidents, 12 source facts and 6 evidence records.
<!-- src: proof/memories.jsonl (32 lines; 6 source + 3 evidence were early writes that landed in alibi-incidents and were rewritten) -->

**Precedent matching.** A precedent is a remembered incident on the same Pyth feed whose time of day falls in this market's settlement window: 14 minutes before to 6 minutes after the reference candle. Each one counts by its severity and fades with a 30-day half-life. Incidents on the same feed at other times count at 0.15×. Memories for other feeds are ignored, and the report lists them with the reason.
<!-- src: README.md "History factor" -->

## How it learned over time

We ran the same gold check twice on the same live data: once with Walrus precedents held back, once with them.
<!-- src: results/before-after.txt; proof/before.json report.verdict/score; proof/after.json report.verdict/score -->

**Before:** "Settlement price looks clean so far — Settlement Risk Score 18/100"

**After:** "Pyth's confidence has blown out at this exact minute before — Settlement Risk Score 34/100 (2 precedents in Walrus Memory)"

Nothing in the live data changed. The memory did. Alibi recalled 23 memories, ignored the ones for other feeds and found two precedents in the gold settlement window:

- "6 Nov: confidence 23.5× normal (12.8 bps), 4 min before this market's reference candle" (blob `d08odBwCOEO2tJQdn-x2wDG7dxyGyywtVpxzp7J8d4E`, weight 0.942)
- "4 Nov: confidence 6.3× normal (3.5 bps), on this market's reference candle" (blob `WzsugL-ETcGRJUEHBvC_3CY4MiO86mk5OSHnFxpgSts`, weight 0.471)

Three gold incidents at other times added a little more. The history factor added 16.2 points. The verdict changed too: it now says what happened before at this exact minute, with the blob ID, so you can check it yourself. And 6 Nov is the prior close this market compares against.

**Calibration.** TODO(calibration): add the calibration numbers (how often a precedent-raised score lined up with a real incident at the next close) once the engine run is done.

## What we found in the data

We scanned 10 days of real Pyth history for gold, silver and EUR/USD, minute by minute, against Hyperliquid. We found 20 incidents on gold, 3 on silver and 16 on EUR/USD, and wrote the strongest 14 to Walrus.
<!-- src: proof/scan-latest.json summary[].incidents; proof/memories.jsonl ALIBI-INCIDENT lines -->

- **6 Nov, 21:55Z, gold:** confidence 23.5× normal (12.8 bps vs a 0.5 bps median), 4 minutes before the settlement candle. Hyperliquid's spread was 0.7 bps, so the reference market was calm.
- **4 Nov, 21:59Z, gold:** confidence 6.3× normal on the settlement candle itself.
- **1 Nov, 22:00Z, EUR/USD:** confidence 33.8× normal (9.1 bps) at the Sunday session open, with 11 publishers.
- **3 Nov, 13:36Z, silver:** a 56.9 bps drop that came back within 5 minutes, while Hyperliquid moved 18.1 bps (5-minute candles).
- Over six days, gold's confidence at the close averaged 1.13 bps, against an all-day median of 0.5 bps. The close is when the feed is least sure, and that is when these markets settle.
<!-- src: proof/memories.jsonl incident + ALIBI-SOURCE close-confidence lines -->

## Honest limits

- **Scope:** gold, silver and EUR/USD only. We run on a trial Pyth key that cannot read commodity futures, so WTI and Brent markets report "feed not readable on this key". Polymarket crypto markets settle on Binance candles and are out of scope.
- **Two of the first three Sui transactions ran through the public node.** All three were simulated through Tatum. When we executed the gold and silver creates, Tatum's free plan returned HTTP 429, and an early version of our code let writes fall back to the public fullnode. Only the gold update (`8DDPzvZg…`) executed through Tatum. We changed the code so writes never fall back, and every record says which provider ran it.
- **A namespace quirk.** Our first 9 source and evidence writes landed in `alibi-incidents`. We rewrote them to the right namespaces; the scorer ignores records by type.
<!-- src: README.md "Tatum and Sui: what actually happened"; proof/sui-tx.jsonl provider fields; proof/memories.jsonl "intended" fields -->

## What's next

- A watch list that alerts you before the settlement minute when the score rises (Watch plan, about $9 a month).
- A JSON micro-API that trading agents pay per check in USDC on Sui (x402/MPP, planned).
- WTI and Brent once we have a full Pyth key.

## Links

- Repo: TODO(link): <repo URL>
- Live demo: TODO(link): <demo URL>
- Demo video: TODO(link): <video URL>
