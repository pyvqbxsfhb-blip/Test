#!/usr/bin/env node
// Baseline PRICE-ONLY momentum engine — no news, no fundamentals.
//
// Purpose: given daily candles, decide whether a name is in a regime that
// tends to KEEP rising (buy / hold) or one that tends to FADE (wait / avoid),
// and time an entry. This is the tool for the DK/EWTX (kept rising) vs
// SGHC/XENE (faded) question: it quantifies the price signature that
// separates continuation from exhaustion.
//
// Input: candles = [{ t, o, h, l, c, v }, ...] oldest -> newest (from
// getDailyBars). Close-only series also work; OHLC/volume sharpen the read.
//
// This file is a BASELINE: pure, deterministic functions you can eyeball and
// tune. Nothing here fetches data or hits the network on import.

// ---------- primitives ----------
const closesOf = (c) => c.map((b) => (typeof b === 'number' ? b : b.c));

export function sma(vals, n) {
  if (vals.length < n) return null;
  let s = 0;
  for (let i = vals.length - n; i < vals.length; i++) s += vals[i];
  return s / n;
}

export function ema(vals, n) {
  if (vals.length < n) return null;
  const k = 2 / (n + 1);
  let e = sma(vals.slice(0, n), n);
  for (let i = n; i < vals.length; i++) e = vals[i] * k + e * (1 - k);
  return e;
}

// Rate of change over the last n bars, in %.
export function roc(closes, n) {
  if (closes.length <= n) return null;
  const a = closes[closes.length - 1 - n];
  if (!a) return null;
  return (closes[closes.length - 1] / a - 1) * 100;
}

// Wilder RSI series aligned to closes (null during warmup).
export function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let gain = 0,
    loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period,
    avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export const rsi = (closes, period = 14) => {
  const s = rsiSeries(closes, period);
  return s[s.length - 1];
};

// Average True Range (needs OHLC). Falls back to close-to-close range.
export function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i],
      p = candles[i - 1];
    const hi = c.h ?? c.c,
      lo = c.l ?? c.c;
    tr.push(Math.max(hi - lo, Math.abs(hi - p.c), Math.abs(lo - p.c)));
  }
  return sma(tr, period);
}

// Trailing consecutive up-days (close > prior close).
export function consecutiveUp(closes) {
  let n = 0;
  for (let i = closes.length - 1; i > 0; i--) {
    if (closes[i] > closes[i - 1]) n++;
    else break;
  }
  return n;
}

// % the last close sits above/below its SMA(n) — "extension". Large positive
// = stretched (mean-reversion / fade risk); near 0 = riding the average.
export function extension(closes, n = 20) {
  const m = sma(closes, n);
  if (!m) return null;
  return (closes[closes.length - 1] / m - 1) * 100;
}

// Normalised slope of SMA(n) over `look` bars, in % (trend direction/strength).
export function smaSlope(closes, n = 20, look = 5) {
  if (closes.length < n + look) return null;
  const now = sma(closes.slice(-n), n);
  const past = sma(closes.slice(-n - look, -look), n);
  if (!past) return null;
  return (now / past - 1) * 100;
}

// Where the last close sits within its own day range: 1 = closed on the high
// (buyers in control), 0 = closed on the low (sellers took over intraday).
export function closeLocation(candle) {
  if (candle.h == null || candle.l == null || candle.h === candle.l) return null;
  return (candle.c - candle.l) / (candle.h - candle.l);
}

// Depth of the deepest pullback in the last `look` bars, in ATR units.
// Shallow (<1 ATR) pullbacks inside an uptrend = strong continuation.
export function pullbackDepthATR(candles, look = 10) {
  const seg = candles.slice(-look);
  if (seg.length < 3) return null;
  const a = atr(candles, 14) || 0;
  if (!a) return null;
  let peak = -Infinity,
    maxDrop = 0;
  for (const b of seg) {
    peak = Math.max(peak, b.h ?? b.c);
    maxDrop = Math.max(maxDrop, peak - (b.l ?? b.c));
  }
  return maxDrop / a;
}

// Bearish RSI divergence: price prints a higher high than a prior peak, but
// RSI at the new high is LOWER than at the old — classic momentum-fade tell.
export function bearishDivergence(closes, period = 14, look = 20) {
  const rs = rsiSeries(closes, period);
  const start = Math.max(period + 1, closes.length - look);
  const seg = [];
  for (let i = start; i < closes.length; i++) seg.push({ i, c: closes[i], r: rs[i] });
  if (seg.length < 6) return false;
  const mid = Math.floor(seg.length / 2);
  const first = seg.slice(0, mid).reduce((a, b) => (b.c > a.c ? b : a));
  const second = seg.slice(mid).reduce((a, b) => (b.c > a.c ? b : a));
  return (
    second.c > first.c && first.r != null && second.r != null && second.r < first.r - 1
  );
}

// ---------- report + classifier ----------
export function report(candles) {
  const closes = closesOf(candles);
  const last = candles[candles.length - 1];
  const sma20 = sma(closes, 20),
    sma50 = sma(closes, 50);
  const px = closes[closes.length - 1];
  return {
    price: px,
    roc5: roc(closes, 5),
    roc10: roc(closes, 10),
    roc20: roc(closes, 20),
    rsi14: rsi(closes, 14),
    sma20,
    sma50,
    stacked: sma20 != null && sma50 != null && px > sma20 && sma20 > sma50,
    slope20: smaSlope(closes, 20, 5),
    extension20: extension(closes, 20),
    consecUp: consecutiveUp(closes),
    atr14: atr(candles, 14),
    pullbackATR: pullbackDepthATR(candles, 10),
    closeLoc: typeof last === 'object' ? closeLocation(last) : null,
    divergence: bearishDivergence(closes, 14, 20),
    nDays: candles.length,
  };
}

// Turn the report into a continuation score (0-100), a fade-risk score, and a
// plain-English entry verdict. Thresholds are deliberate, visible defaults.
export function classify(candles) {
  const r = report(candles);
  let cont = 0,
    fade = 0;
  const why = [];

  // Trend structure — the backbone of continuation.
  if (r.stacked) {
    cont += 25;
    why.push('price>20>50 (stacked uptrend)');
  } else why.push('not stacked (no clean uptrend)');
  if (r.slope20 != null && r.slope20 > 0) cont += 15;

  // Momentum strength, but penalise overbought.
  if (r.rsi14 != null) {
    if (r.rsi14 >= 55 && r.rsi14 <= 72) {
      cont += 20;
      why.push(`RSI ${r.rsi14.toFixed(0)} (healthy)`);
    } else if (r.rsi14 > 72) {
      fade += 20;
      why.push(`RSI ${r.rsi14.toFixed(0)} (overbought)`);
    } else if (r.rsi14 < 45) {
      fade += 10;
      why.push(`RSI ${r.rsi14.toFixed(0)} (weak)`);
    }
  }

  // Extension: moderate good, extreme = stretched -> fade risk.
  if (r.extension20 != null) {
    if (r.extension20 > 18) {
      fade += 25;
      why.push(`+${r.extension20.toFixed(0)}% above 20MA (stretched)`);
    } else if (r.extension20 >= 2 && r.extension20 <= 12) {
      cont += 10;
      why.push(`+${r.extension20.toFixed(0)}% above 20MA (riding)`);
    }
  }

  // Pullback quality.
  if (r.pullbackATR != null) {
    if (r.pullbackATR < 1.2) cont += 10;
    else if (r.pullbackATR > 2.5) fade += 10;
  }

  // Close strength (buyers vs sellers into the bell).
  if (r.closeLoc != null) {
    if (r.closeLoc >= 0.66) cont += 10;
    else if (r.closeLoc <= 0.33) {
      fade += 15;
      why.push('weak close (off the highs)');
    }
  }

  // The exhaustion tell.
  if (r.divergence) {
    fade += 30;
    why.push('bearish RSI divergence (higher price, lower RSI)');
  }

  cont = Math.max(0, Math.min(100, cont));
  fade = Math.max(0, Math.min(100, fade));

  let verdict;
  if (!r.stacked) verdict = 'NO-TREND — stand aside';
  else if (r.divergence || fade >= 45) verdict = 'FADE-RISK — do NOT chase, wait';
  else if (r.extension20 != null && r.extension20 > 18)
    verdict = 'EXTENDED — wait for a pullback to the 20MA';
  else if (r.rsi14 != null && r.rsi14 >= 45 && r.rsi14 <= 60 && r.slope20 > 0)
    verdict = 'BUY-ZONE — shallow pullback inside an uptrend';
  else if (cont >= 55) verdict = 'CONTINUATION — trend intact, buy strength/pullbacks';
  else verdict = 'MIXED — no edge';

  return { ...r, continuation: cont, fadeRisk: fade, verdict, notes: why };
}

// Compare several named series side by side (what separates the risers from
// the faders). names = { TICKER: candles[] }.
export function compare(named) {
  const rows = Object.entries(named).map(([sym, candles]) => ({
    sym,
    ...classify(candles),
  }));
  return rows;
}

// ---------- optional CLI (only runs when invoked directly) ----------
// Usage: node src/momentum.js DK EWTX SGHC XENE
// NOTE: this fetches live candles when run — it is intentionally NOT executed
// on import, so requiring this module for its functions costs no network.
const isMain = process.argv[1] && process.argv[1].endsWith('momentum.js');
if (isMain) {
  const tickers = process.argv.slice(2);
  if (!tickers.length) {
    console.error('Usage: node src/momentum.js <TICKER...>  (e.g. DK EWTX SGHC XENE)');
    process.exit(1);
  }
  const { launchBrowser, openSite, scanGainers, getDailyBars } = await import(
    './tradingview.js'
  );
  const { DEFAULTS } = await import('./config.js');
  const b = await launchBrowser();
  try {
    const page = await openSite(b);
    // Resolve each ticker to its full EXCHANGE:SYMBOL via a scan lookup.
    const { rows } = await scanGainers(page, { ...DEFAULTS, scanSize: 300, minChangePct: -100 });
    const map = new Map(rows.map((r) => [r.symbol, r.fullSymbol]));
    const named = {};
    for (const t of tickers) {
      const full = map.get(t) || `NASDAQ:${t}`;
      const candles = await getDailyBars(page, full, 60);
      if (candles && candles.length) named[t] = candles;
      else console.error(`  ! no candles for ${t}`);
    }
    const rowsOut = compare(named);
    const pad = (s, n) => String(s).padEnd(n).slice(0, n);
    console.log(
      '\n' +
        pad('SYM', 6) + pad('PX', 9) + pad('ROC5', 8) + pad('RSI', 6) +
        pad('EXT%', 7) + pad('SLOPE', 7) + pad('UP', 4) + pad('DIV', 5) +
        pad('CONT', 6) + pad('FADE', 6) + 'VERDICT'
    );
    console.log('-'.repeat(96));
    for (const r of rowsOut) {
      console.log(
        pad(r.sym, 6) +
          pad('$' + (r.price ?? 0).toFixed(2), 9) +
          pad((r.roc5 ?? 0).toFixed(1), 8) +
          pad((r.rsi14 ?? 0).toFixed(0), 6) +
          pad((r.extension20 ?? 0).toFixed(1), 7) +
          pad((r.slope20 ?? 0).toFixed(1), 7) +
          pad(r.consecUp, 4) +
          pad(r.divergence ? 'YES' : '-', 5) +
          pad(r.continuation, 6) +
          pad(r.fadeRisk, 6) +
          r.verdict
      );
    }
    console.log('');
  } finally {
    await b.close();
  }
}
