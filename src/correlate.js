#!/usr/bin/env node
// Correlation + momentum snapshot for a set of tickers, as of a chosen date.
//
// Usage:
//   node src/correlate.js DK EWTX SGHC XENE --asof 2026-07-09 --days 90
//
// Fetches daily candles (live), truncates to the --asof close ("backtrack"),
// runs the price-only momentum classifier per name, and computes a pairwise
// Pearson correlation matrix of daily returns (full window + last 20 bars).

import { launchBrowser, openSite, getDailyBars } from './tradingview.js';
import { classify, momentumScore } from './momentum.js';

function parse(argv) {
  const tickers = [];
  let asof = null,
    days = 90,
    win = 20;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--asof') asof = argv[++i];
    else if (a === '--days') days = Number(argv[++i]);
    else if (a === '--win') win = Number(argv[++i]);
    else tickers.push(a);
  }
  return { tickers, asof, days, win };
}

// Resolve a bare ticker to EXCHANGE:SYMBOL by trying common venues.
async function fetchCandles(page, ticker, count) {
  const candidates = ticker.includes(':')
    ? [ticker]
    : [`NASDAQ:${ticker}`, `NYSE:${ticker}`, `AMEX:${ticker}`];
  for (const full of candidates) {
    const c = await getDailyBars(page, full, count);
    if (c && c.length) return { full, candles: c };
  }
  return { full: null, candles: null };
}

function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  const xa = a.slice(-n),
    xb = b.slice(-n);
  const ma = xa.reduce((s, v) => s + v, 0) / n;
  const mb = xb.reduce((s, v) => s + v, 0) / n;
  let cov = 0,
    va = 0,
    vb = 0;
  for (let i = 0; i < n; i++) {
    const da = xa[i] - ma,
      db = xb[i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  if (va === 0 || vb === 0) return null;
  return cov / Math.sqrt(va * vb);
}

// daily log returns keyed by timestamp
function returnsByTs(candles) {
  const m = new Map();
  for (let i = 1; i < candles.length; i++) {
    const r = Math.log(candles[i].c / candles[i - 1].c);
    if (Number.isFinite(r)) m.set(candles[i].t, r);
  }
  return m;
}

function alignedReturns(cA, cB, lastN) {
  const ra = returnsByTs(cA),
    rb = returnsByTs(cB);
  const common = [...ra.keys()].filter((t) => rb.has(t)).sort((x, y) => x - y);
  const use = lastN ? common.slice(-lastN) : common;
  return [use.map((t) => ra.get(t)), use.map((t) => rb.get(t))];
}

const pad = (s, n) => String(s).padEnd(n).slice(0, n);

async function main() {
  const { tickers, asof, days, win } = parse(process.argv);
  if (!tickers.length) {
    console.error('Usage: node src/correlate.js DK EWTX SGHC XENE --asof 2026-07-09');
    process.exit(1);
  }
  const cutoff = asof ? Date.parse(`${asof}T23:59:59Z`) / 1000 : Infinity;

  const b = await launchBrowser();
  const series = {};
  try {
    const page = await openSite(b);
    for (const t of tickers) {
      const { full, candles } = await fetchCandles(page, t, days);
      if (!candles) {
        console.error(`  ! no candles for ${t}`);
        continue;
      }
      const trimmed = candles.filter((c) => c.t <= cutoff);
      series[t] = { full, candles: trimmed };
      const lastDate = new Date(trimmed[trimmed.length - 1].t * 1000)
        .toISOString()
        .slice(0, 10);
      console.error(`  ✓ ${t} (${full}) ${trimmed.length} bars, last = ${lastDate}`);
    }
  } finally {
    await b.close();
  }

  const syms = Object.keys(series);
  if (syms.length < 2) {
    console.error('Need at least 2 resolved tickers.');
    process.exit(1);
  }

  // ---- momentum snapshot as of --asof ----
  console.log(`\n=== MOMENTUM as of ${asof || 'latest'} (price-only) ===`);
  console.log(
    pad('SYM', 6) + pad('CLOSE', 9) + pad('ROC5', 8) + pad('ROC10', 8) +
      pad('RSI', 6) + pad('EXT%', 7) + pad('UP', 4) + pad('DIV', 5) +
      pad('SCORE', 7) + 'VERDICT'
  );
  console.log('-'.repeat(100));
  const scored = syms
    .map((s) => ({ s, ms: momentumScore(series[s].candles), r: classify(series[s].candles) }))
    .sort((a, b) => b.ms.score - a.ms.score);
  for (const { s, ms, r } of scored) {
    console.log(
      pad(s, 6) +
        pad('$' + (r.price ?? 0).toFixed(2), 9) +
        pad((r.roc5 ?? 0).toFixed(1), 8) +
        pad((r.roc10 ?? 0).toFixed(1), 8) +
        pad((r.rsi14 ?? 0).toFixed(0), 6) +
        pad((r.extension20 ?? 0).toFixed(1), 7) +
        pad(r.consecUp, 4) +
        pad(r.divergence ? 'YES' : '-', 5) +
        pad(ms.score >= 0 ? '+' + ms.score : ms.score, 7) +
        r.verdict
    );
  }

  // ---- correlation matrices ----
  const printMatrix = (label, lastN) => {
    console.log(`\n=== RETURN CORRELATION ${label} ===`);
    console.log(pad('', 6) + syms.map((s) => pad(s, 8)).join(''));
    for (const a of syms) {
      let row = pad(a, 6);
      for (const c of syms) {
        if (a === c) {
          row += pad('1.00', 8);
          continue;
        }
        const [ra, rb] = alignedReturns(series[a].candles, series[c].candles, lastN);
        const r = pearson(ra, rb);
        row += pad(r == null ? '—' : r.toFixed(2), 8);
      }
      console.log(row);
    }
  };
  printMatrix('(full window)', null);
  printMatrix(`(last ${win} bars)`, win);

  // ---- DK vs EWTX callout if both present ----
  if (series.DK && series.EWTX) {
    const [ra, rb] = alignedReturns(series.DK.candles, series.EWTX.candles, null);
    const [ra20, rb20] = alignedReturns(series.DK.candles, series.EWTX.candles, win);
    console.log(
      `\nDK vs EWTX return correlation: full=${(pearson(ra, rb) ?? 0).toFixed(2)}, ` +
        `last ${win}=${(pearson(ra20, rb20) ?? 0).toFixed(2)}`
    );
  }
  console.log('');
}

main().catch((e) => {
  console.error('✖ correlate failed:', e.message);
  process.exit(1);
});
