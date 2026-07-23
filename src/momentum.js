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

// Fraction of up-days over the last n bars (climb consistency).
export function upDayRatio(closes, n = 10) {
  if (closes.length < n + 1) return null;
  let up = 0;
  for (let i = closes.length - n; i < closes.length; i++) if (closes[i] > closes[i - 1]) up++;
  return up / n;
}

// Recent avg volume vs the prior stretch — >1 means the move has participation.
export function volumeRatio(candles, recent = 5, base = 15) {
  if (candles.length < recent + base || candles[0].v == null) return null;
  const avg = (arr) => arr.reduce((s, b) => s + (b.v || 0), 0) / arr.length;
  const r = avg(candles.slice(-recent));
  const b = avg(candles.slice(-recent - base, -recent));
  if (!b) return null;
  return r / b;
}

// % below the 20-day high (0 = at the high, breakout).
export function pctBelow20High(candles) {
  const seg = candles.slice(-20);
  if (!seg.length) return null;
  const hi = Math.max(...seg.map((b) => b.h ?? b.c));
  if (!hi) return null;
  return (1 - candles[candles.length - 1].c / hi) * 100;
}

// Volatility-adjusted increment: recent % move per unit of ATR% (clean thrust).
export function volAdjThrust(candles, n = 5) {
  const closes = candles.map((b) => b.c);
  const r = roc(closes, n);
  const a = atr(candles, 14);
  const px = closes[closes.length - 1];
  if (r == null || !a || !px) return null;
  const atrPct = (a / px) * 100;
  return atrPct ? r / atrPct : null;
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
    upDayRatio: upDayRatio(closes, 10),
    volRatio: volumeRatio(candles),
    pctBelow20High: pctBelow20High(candles),
    volAdjThrust: volAdjThrust(candles, 5),
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

// Signed momentum score (~ -100 .. +100). Three modes:
//   'increment'   (A, default) — rank by SIZE + CLEANLINESS of the move; no
//                 overbought/extension brake (accepts stretched names). Only
//                 penalties are for the increment itself failing (divergence,
//                 weak close, stall).
//   'balanced'    (B) — increment rewarded, but overbought/extension still drag.
//   'sustainable' (C) — increment rewarded, spikes on weak volume punished.
// Weights are visible constants — tune, don't trust blindly.
const MODE_WEIGHTS = {
  increment: { thrust: 0.8, medium: 0.3, accel: 0.5, vadj: 6, vol: 15, cons: 24, brake: 'off' },
  balanced: { thrust: 0.55, medium: 0.45, accel: 0.6, vadj: 4, vol: 12, cons: 20, brake: 'on' },
  sustainable: { thrust: 0.5, medium: 0.35, accel: 0.4, vadj: 5, vol: 20, cons: 28, brake: 'weakvol' },
  // Mode D — distilled from A: KEEP A's raw increment weights, ENFORCE the
  // quality dims that gave A its edge (heavier vadj/volume/consistency), and
  // RESOLVE A's fade weakness with a graduated 'soft' brake that only bites at
  // genuine exhaustion (extreme RSI, very stretched, or overbought+decelerating).
  refined: { thrust: 0.8, medium: 0.3, accel: 0.5, vadj: 8, vol: 18, cons: 28, brake: 'soft' },
  // Mode W ('early') — catch the move as it STARTS: heavy fresh thrust +
  // acceleration + volume surge, minimal established-trend requirement. Enters
  // a bar or two sooner than A-D (more false starts is the trade-off).
  early: { thrust: 1.0, medium: 0.1, accel: 1.0, vadj: 4, vol: 22, cons: 8, brake: 'off' },
  // Mode X ('breakout') — buy the breakout: at/near the 20-day high with volume
  // expansion + thrust (bo weight rewards proximity to the high).
  breakout: { thrust: 0.5, medium: 0.3, accel: 0.4, vadj: 4, vol: 16, cons: 10, brake: 'off', bo: 1.0 },
  // Mode Y ('pullback') — buy the DIP in an established uptrend: stacked + rising
  // slope + RSI cooled to ~40-58 near a rising MA. Opposite temperament to W;
  // low thrust, overbought braked (dip weight rewards the cooled-in-uptrend state).
  pullback: { thrust: 0.15, medium: 0.4, accel: 0.2, vadj: 2, vol: 6, cons: 6, brake: 'on', dip: 1.0 },
};

export function momentumScore(candles, mode = 'increment') {
  const r = report(candles);
  const W = MODE_WEIGHTS[mode] || MODE_WEIGHTS.increment;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const roc5 = r.roc5 ?? 0,
    roc10 = r.roc10 ?? 0;
  const accel = 2 * roc5 - roc10; // last 5 bars vs the 5 before them

  // breakout proximity (1 = at 20d high) and pullback-in-uptrend magnitude
  const boMag = r.pctBelow20High == null ? 0 : clamp(1 - r.pctBelow20High / 6, -0.5, 1);
  let dipMag = 0;
  if ((W.dip || 0) && r.stacked && r.slope20 > 0 && r.rsi14 != null) {
    const rsiFit = r.rsi14 >= 38 && r.rsi14 <= 62 ? Math.max(0, 1 - Math.abs(r.rsi14 - 48) / 14) : 0;
    const pulled = r.extension20 != null && r.extension20 < 8 ? 1 : 0.4; // near a rising MA
    dipMag = rsiFit * pulled;
  }

  const parts = {
    thrust: W.thrust * clamp(roc5, -25, 25), // recent push (increment)
    medium: W.medium * clamp(roc10, -40, 40), // medium-term trend
    accel: W.accel * clamp(accel, -25, 25), // fresh acceleration vs fading
    volAdjThrust: r.volAdjThrust != null ? clamp(r.volAdjThrust, -3, 4) * W.vadj : 0, // clean thrust per ATR
    volume: r.volRatio != null ? clamp(r.volRatio - 1, -0.6, 0.8) * W.vol : 0, // participation
    consistency: r.upDayRatio != null ? (r.upDayRatio - 0.5) * W.cons : 0, // steady climb
    breakout:
      r.pctBelow20High == null ? 0 : r.pctBelow20High <= 1 ? 6 : r.pctBelow20High > 10 ? -4 : 0,
    breakoutX: (W.bo || 0) * boMag * 18, // Mode X: reward proximity to the 20d high
    pullbackY: (W.dip || 0) * dipMag * 30, // Mode Y: reward cooled-in-uptrend dip
    structure:
      (r.stacked ? 6 : 0) + (r.slope20 > 0 ? 4 : 0) + 1.0 * clamp(r.consecUp || 0, 0, 6),
  };

  // Drag. In mode A the overbought/extension brake is OFF (we accept stretched
  // names); only signs the increment is *failing* still count.
  let ex = 0;
  if (W.brake === 'on') {
    if (r.rsi14 != null) {
      if (r.rsi14 >= 84) ex += 38;
      else if (r.rsi14 >= 80) ex += 20;
      else if (r.rsi14 >= 74) ex += 8;
    }
    if (r.extension20 != null) {
      if (r.extension20 > 22) ex += 10;
      else if (r.extension20 > 16) ex += 4;
    }
  }
  if (W.brake === 'weakvol' && r.volRatio != null && r.volRatio < 0.9) ex += 12;
  if (W.brake === 'soft') {
    // Graduated: only genuine exhaustion, not every stretched name.
    if (r.rsi14 != null) {
      if (r.rsi14 >= 85) ex += 18;
      else if (r.rsi14 >= 78) ex += 6;
    }
    if (r.extension20 != null && r.extension20 > 28) ex += 8;
    if (r.rsi14 != null && r.rsi14 >= 74 && accel < 0) ex += 10; // overbought AND rolling over
  }
  if (r.divergence) ex += mode === 'increment' ? 10 : 20; // increment weakening internally
  if (r.closeLoc != null && r.closeLoc <= 0.33) ex += mode === 'increment' ? 6 : 8;
  if ((r.consecUp || 0) === 0 && roc5 < 8) ex += mode === 'increment' ? 6 : 10; // stalling
  parts.exhaustion = -ex;

  const raw = Object.values(parts).reduce((s, v) => s + v, 0);
  return { score: Math.round(clamp(raw, -100, 100)), parts, mode, report: r };
}

// Mode S ('sustained') — ORTHOGONAL to the candle-momentum modes. Scores a
// scanner ROW (not candles) on proven momentum-PERSISTENCE techniques:
//   - multi-month momentum factor (Perf 3M/6M/1Y — Jegadeesh-Titman)
//   - ADX trend strength (Wilder)
//   - Stage-2 MA alignment (price > 50-MA > 200-MA — Minervini/Weinstein)
//   - aggregate technical rating (Recommend.All)
//   - low-float bonus
// Because it eats different data, it picks different names than A–Z.
export function sustainedScore(row) {
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const p3 = row.perf3M ?? 0, p6 = row.perf6M ?? 0, pY = row.perfY ?? 0;
  const parts = {
    // multi-month relative strength (the proven persistence factor)
    momentum:
      (clamp(p3, -30, 150) / 150 * 0.4 +
        clamp(p6, -30, 250) / 250 * 0.35 +
        clamp(pY, -50, 400) / 400 * 0.25) * 40,
    // trend strength: ADX 15->0, 50->22
    adx: clamp(((row.adx ?? 0) - 15) / 35, 0, 1) * 22,
    // Stage-2 alignment: price > 50MA > 200MA
    stage:
      row.sma50 && row.sma200 && row.price
        ? row.price > row.sma50 && row.sma50 > row.sma200
          ? 16
          : row.price > row.sma50
            ? 9
            : row.price > row.sma200
              ? 4
              : 0
        : 0,
    // aggregate technical rating -1..+1 -> 0..12
    rating: ((clamp(row.techRating ?? 0, -1, 1) + 1) / 2) * 12,
    // low-float bonus (explosive, sustainable squeezes)
    float: row.floatPct == null ? 0 : row.floatPct < 40 ? 10 : row.floatPct < 70 ? 5 : 0,
  };
  const raw = Object.values(parts).reduce((a, b) => a + b, 0);
  return { score: Math.round(clamp(raw, 0, 100)), parts };
}

// Mode I ('impact') — MAGNITUDE of the move: how much real money/scale is
// behind it. Big dollar-volume + volume surge + pop. Favours liquid, high-
// conviction moves (institutional-scale), not thin spikes.
export function impactScore(row) {
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const vt = row.valueTraded ?? 0; // today's traded $ value
  const dollarVol = vt > 0 ? clamp((Math.log10(vt) - 6) / 4, 0, 1) : 0; // $1M->0, $10B->1
  const relVol = clamp(((row.relVolume ?? 1) - 1) / 5, 0, 1); // 1x->0, 6x+->1
  const move = clamp((row.changePct ?? 0) / 25, 0, 1);
  const parts = { dollarVol: dollarVol * 50, relVol: relVol * 25, move: move * 25 };
  return { score: Math.round(clamp(parts.dollarVol + parts.relVol + parts.move, 0, 100)), parts };
}

// Mode F ('fomo') — CROWD-CHASE proxy (price/volume sentiment, not social):
// relative-volume surge + opening gap + pop magnitude = "everyone is piling in
// right now". Favours explosive spikes regardless of size. (True social
// sentiment would need an external feed — this is the behavioural footprint.)
export function fomoScore(row) {
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const relVol = clamp(((row.relVolume ?? 1) - 1) / 6, 0, 1); // steeper: crowd surge
  const gap = clamp((row.gap ?? 0) / 15, 0, 1); // gap-up chase
  const move = clamp((row.changePct ?? 0) / 25, 0, 1);
  const parts = { relVol: relVol * 40, gap: gap * 35, move: move * 25 };
  return { score: Math.round(clamp(parts.relVol + parts.gap + parts.move, 0, 100)), parts };
}

// Mode Z (consensus / meta): for a day's pool of scored names, assign each an
// mZ = average cross-sectional percentile across the base modes. A name ranked
// highly by ALL modes scores ~100; high in one but low in others scores middling.
// Rewards breadth of agreement. Mutates names (sets .mZ) and returns them.
export const BASE_MODE_KEYS = ['mA', 'mB', 'mC', 'mD', 'mW'];
export function assignConsensus(names) {
  const keys = BASE_MODE_KEYS.filter((k) => names.some((n) => n[k] != null));
  const pctByKey = {};
  for (const k of keys) {
    const vals = names.filter((n) => n[k] != null).map((n) => n[k]);
    const m = vals.length;
    pctByKey[k] = new Map();
    for (const n of names) {
      if (n[k] == null) continue;
      let lt = 0, eq = 0;
      for (const v of vals) { if (v < n[k]) lt++; else if (v === n[k]) eq++; }
      pctByKey[k].set(n, m > 1 ? ((lt + (eq - 1) / 2) / (m - 1)) * 100 : 100);
    }
  }
  for (const n of names) {
    const ps = keys.map((k) => pctByKey[k].get(n)).filter((v) => v != null);
    n.mZ = ps.length ? Math.round(ps.reduce((a, b) => a + b, 0) / ps.length) : null;
  }
  return names;
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
