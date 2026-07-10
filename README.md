# TradingView Top-Gainers Scanner

A live US-equity **top-gainers scanner** that drives a **real headless Chromium
against tradingview.com** (JS-rendered live data — never static/cached HTML) and
runs a disciplined 4-step trend / size / 10x pipeline.

> ⚠️ **Not investment advice.** This is a screening aid. It surfaces a shortlist;
> a human confirms live prices and makes every decision (Step 4).

## Why a browser (and not scraped HTML)

Every data pull runs **inside a loaded tradingview.com page context**, using the
site's own live services:

- **Step 1 gainers** come from TradingView's live **scanner** service, executed
  from within the page (JS `fetch`, site origin/cookies) — the same feed the
  TradingView screener UI uses. This avoids the stale, days-to-weeks-old
  snapshots that cached screener/list HTML pages are frequently served with.
- **Exact trend verification** streams **daily OHLC bars over TradingView's own
  data websocket** (the same socket the charts use), so consecutive-up-day
  counts and 52-week-high checks are computed from real bars, per ticker.

## The pipeline

**Step 1 — Live gainers.** Pull current top % gainers on NASDAQ/NYSE/AMEX, with
price, market cap, sector, volume, beta and multi-horizon performance.

**Step 2 — Trend + size filter.** Keep only names meeting **both**:
- **(a) Trending up** = **at a new 52-week high** *(exact: close within 0.5% of
  the 52w high)* **OR** **≥ 5 consecutive up-days** *(exact, from daily bars)*.
  This rejects one-day pops inside a downtrend.
- **(b) Market cap US$500M–$50B.**

**Step 3 — Prioritize 10x.** Rank survivors by realistic 10x upside — skewed to
**US$500M–$10B** with strong momentum and high beta. A $30–50B base is
near-impossible to 10x and is scored down accordingly.

**Step 4 — Manual review.** The shortlist is handed to you. **Confirm live
prices before acting.**

### Hard rules encoded

- **Floor:** market cap > US$500M (screens out sub-$500M pump/halt-trap microcaps).
- **Anti-pump band ($500M–$1B):** a one-day spike prints its own new high on the
  spike day, so the 52w-high leg is **not trusted** here — these names must clear
  the **5-consecutive-up-day** leg instead.
- **High beta (> 1.5) preferred** (soft signal in the score, not a hard cut).
- **Liquidity:** average daily **dollar**-volume must clear a floor so a +50%
  exit can be absorbed.
- **Industry-agnostic:** all sectors screened equally; no name is rejected for
  being "hype" or "low quality". Market reaction matters, not catalyst substance.

### The structural tension (be honest about it)

"Near a 52-week high" and "10x potential" pull in opposite directions — new-high
names tend to be mature leaders (low ceiling), while genuine 10x frontier names
are the volatile gainers *not* at their highs. Choose the bias per run:

- `--mode uptrend-first` — steady, confirmed trends; lower ceiling.
- `--mode tenx-first` — asymmetric upside; higher risk (often not at highs).
- `--mode balanced` — blend (default).

## Setup

Environment provides Node ≥ 20, a global Playwright, and a Chromium at
`/opt/pw-browsers/chromium`.

```bash
./setup.sh
```

## Usage

```bash
node src/scan.js                 # live scan, balanced ranking, table output
node src/scan.js --mode tenx-first --top 30
node src/scan.js --rejects       # also show why names were dropped
node src/scan.js --json          # machine-readable output
node src/scan.js --help          # all flags
```

Key flags: `--mode`, `--min-change`, `--cap-min`, `--cap-max`, `--scan-size`,
`--max-enrich`, `--top`, `--no-enrich`, `--rejects`, `--json`.

### Reading the trend legs

| Tag          | Meaning                                                            |
|--------------|-------------------------------------------------------------------|
| `52w-high`   | At / within 0.5% of a new 52-week high (exact).                   |
| `Nd-up`      | N **exact** consecutive up-days from live daily bars.            |
| `wk-up~`     | Weekly **and** monthly performance both positive — an *approximate* uptrend leg used only when daily bars weren't captured for that name. |
| `anti-pump`  | $500M–$1B name: high-leg not trusted; cleared via the up-day leg. |

Raise `--max-enrich` to force exact daily-bar verification on more names (the
default verifies the highest-change size-band survivors and flags the rest).

## Environment notes

- Chromium is routed through the session's egress proxy. The proxy re-terminates
  TLS but doesn't implement TLS 1.3 Encrypted Client Hello, so the launcher pins
  **TLS 1.2** and disables ECH/DoH to make the MITM handshake succeed. This only
  applies when `HTTPS_PROXY` is set; direct runs use defaults.
- Daily-bar enrichment is **best-effort**: any symbol whose websocket capture
  times out cleanly falls back to the `wk-up~` proxy and is flagged — the run
  never fails because of one ticker.

## Momentum scoring (price-only)

Separate from the scanner's 10x pipeline, `src/momentum.js` grades a name's
**price action alone** — no news, no fundamentals — to help time entries.

- **Signals**: ROC, Wilder RSI, ATR, 20/50 SMA structure & slope, extension
  above the 20-day MA, close-location-in-range, ATR-scaled pullback depth,
  bearish RSI divergence, up-day consistency, volume participation,
  volatility-adjusted thrust (ROC ÷ ATR), and distance to the 20-day high.
- **`classify(candles)`** → an entry verdict: `NO-TREND` / `BUY-ZONE` /
  `CONTINUATION` / `EXTENDED` / `FADE-RISK`.
- **`momentumScore(candles, mode)`** → a single signed score (~ −100..+100) in
  one of three modes:
  - `increment` (default) — rank by **size + cleanliness** of the move;
    overbought/extension brake **off** (accepts stretched names).
  - `balanced` — increment rewarded, but overbought/extension still drag.
  - `sustainable` — punishes spikes on weak volume.

The scanner surfaces `momScore` (mode `increment`) in its `--json` output,
computed from the candles captured during enrichment.

## Comparing & monitoring

```bash
# Momentum snapshot + return-correlation matrix, backtestable to any date:
node src/correlate.js DK EWTX SGHC XENE --asof 2026-07-09 --days 90

# Freeze a scored watchlist to snapshots/<date>.json (durable across sessions),
# then later grade whether the score predicted the moves:
node src/monitor.js snapshots/2026-07-10.json
```

`monitor.js` reloads a baseline, pulls each name's latest price, shows the move
since capture, and reports the **Spearman rank correlation** between the
baseline score and the realized move (+1 = score predicted the ranking
perfectly, 0 = no signal, −1 = inverted). It needs at least one session close
*after* capture to have anything to grade.

## Layout

```
src/
  scan.js         CLI entry / arg parsing / orchestration
  tradingview.js  headless browser + live scanner fetch + daily-bar (OHLCV) websocket
  pipeline.js     trend/size/liquidity filters, consecutive-up-days, 10x scoring
  momentum.js     price-only signals, entry classifier, signed momentum score
  correlate.js    as-of momentum snapshot + return-correlation matrix
  monitor.js      grade a saved baseline against later prices (Spearman)
  format.js       table + reject-summary rendering
  config.js       default thresholds (all CLI-overridable)
snapshots/        frozen scored watchlists for monitoring
```

> ⚠️ Screening + momentum aids only — **not investment advice.** Confirm live
> prices before acting.
