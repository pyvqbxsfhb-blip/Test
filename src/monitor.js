#!/usr/bin/env node
// Monitor a saved baseline snapshot: pull each name's latest price, show the
// move since capture, recompute the momentum score, and measure whether the
// baseline score predicted the realized ranking (Spearman rank correlation).
//
// Usage: node src/monitor.js snapshots/2026-07-10.json

import fs from 'fs';
import { launchBrowser, openSite, getDailyBars } from './tradingview.js';
import { momentumScore } from './momentum.js';

async function fetchCandles(page, ticker, count) {
  const cands = ticker.includes(':')
    ? [ticker]
    : [`NASDAQ:${ticker}`, `NYSE:${ticker}`, `AMEX:${ticker}`];
  for (const full of cands) {
    const c = await getDailyBars(page, full, count);
    if (c && c.length) return c;
  }
  return null;
}

// Spearman rank correlation between two arrays.
function spearman(a, b) {
  const rank = (arr) => {
    const idx = arr.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
    const r = new Array(arr.length);
    idx.forEach(([, i], k) => (r[i] = k + 1));
    return r;
  };
  const ra = rank(a),
    rb = rank(b),
    n = a.length;
  if (n < 3) return null;
  let d2 = 0;
  for (let i = 0; i < n; i++) d2 += (ra[i] - rb[i]) ** 2;
  return 1 - (6 * d2) / (n * (n * n - 1));
}

const pad = (s, n) => String(s).padEnd(n).slice(0, n);

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node src/monitor.js <snapshot.json>');
    process.exit(1);
  }
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`Baseline captured: ${snap.capturedAt}  (score mode: ${snap.scoreMode})`);

  const b = await launchBrowser();
  const rows = [];
  try {
    const page = await openSite(b);
    for (const nm of snap.names) {
      const candles = await fetchCandles(page, nm.symbol, 70);
      if (!candles) {
        console.error(`  ! no data for ${nm.symbol}`);
        continue;
      }
      const cur = candles[candles.length - 1].c;
      const lastDate = new Date(candles[candles.length - 1].t * 1000).toISOString().slice(0, 10);
      const movePct = ((cur - nm.refPrice) / nm.refPrice) * 100;
      const nowScore = momentumScore(candles).score;
      rows.push({
        sym: nm.symbol,
        ref: nm.refPrice,
        cur,
        lastDate,
        movePct,
        was: nm.momScoreA,
        now: nowScore,
      });
    }
  } finally {
    await b.close();
  }

  rows.sort((a, b) => b.was - a.was); // ranked by ORIGINAL score
  console.log(
    '\n' +
      pad('SYM', 7) + pad('REF', 9) + pad('NOW', 9) + pad('MOVE%', 8) +
      pad('MOM@base', 10) + pad('MOM@now', 9) + 'lastBar'
  );
  console.log('-'.repeat(64));
  for (const r of rows) {
    console.log(
      pad(r.sym, 7) +
        pad('$' + r.ref.toFixed(2), 9) +
        pad('$' + r.cur.toFixed(2), 9) +
        pad((r.movePct >= 0 ? '+' : '') + r.movePct.toFixed(1), 8) +
        pad((r.was >= 0 ? '+' : '') + r.was, 10) +
        pad((r.now >= 0 ? '+' : '') + r.now, 9) +
        r.lastDate
    );
  }

  const moves = rows.map((r) => r.movePct);
  const spread = Math.max(...moves) - Math.min(...moves);
  if (spread < 0.1) {
    console.log(
      `\nNo movement since capture yet (all ${'≈'}0%). Nothing to score — ` +
        `re-run after a session close.\n`
    );
    return;
  }
  const rho = spearman(rows.map((r) => r.was), moves);
  console.log(
    `\nDid the score predict the ranking?  Spearman(momentum@base, realized move) = ` +
      `${rho == null ? 'n/a' : rho.toFixed(2)}`
  );
  console.log(
    rho == null
      ? ''
      : rho > 0.5
        ? '  → strong: higher score → bigger gain. Formula is working.'
        : rho > 0.2
          ? '  → mild positive: some predictive value.'
          : rho > -0.2
            ? '  → ~none: score did not rank the moves this window.'
            : '  → inverted: high scorers underperformed — revisit weights.'
  );
  console.log('');
}

main().catch((e) => {
  console.error('✖ monitor failed:', e.message);
  process.exit(1);
});
