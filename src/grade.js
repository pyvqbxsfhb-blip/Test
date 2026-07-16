#!/usr/bin/env node
// Grade a day's momentum picks against realized forward moves, per mode.
// For each name in the snapshot: fetch its latest close, compute the move from
// the snapshot's reference price, then measure how well each mode's score
// (A/B/C) ranked those moves (Spearman) and how the top-10 of each mode fared.
//
// Usage: node src/grade.js snapshots/daily-2026-07-14.json

import fs from 'fs';
import { launchBrowser, openSite, getDailyBars } from './tradingview.js';

async function fetchLatest(page, ticker) {
  const cands = ticker.includes(':')
    ? [ticker]
    : [`NASDAQ:${ticker}`, `NYSE:${ticker}`, `AMEX:${ticker}`];
  for (const full of cands) {
    const c = await getDailyBars(page, full, 5);
    if (c && c.length) return { c: c[c.length - 1].c, t: c[c.length - 1].t };
  }
  return null;
}

function spearman(a, b) {
  const rank = (arr) => {
    const idx = arr.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
    const r = new Array(arr.length);
    idx.forEach(([, i], k) => (r[i] = k + 1));
    return r;
  };
  const n = a.length;
  if (n < 3) return null;
  const ra = rank(a), rb = rank(b);
  let d2 = 0;
  for (let i = 0; i < n; i++) d2 += (ra[i] - rb[i]) ** 2;
  return 1 - (6 * d2) / (n * (n * n - 1));
}

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node src/grade.js <snapshot.json>');
    process.exit(1);
  }
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
  const names = snap.names || snap.ranking || [];
  console.log(`Grading ${snap.date} — ${names.length} names (ref = capture price)`);

  const b = await launchBrowser();
  const rows = [];
  try {
    const page = await openSite(b);
    for (const n of names) {
      const cur = await fetchLatest(page, n.symbol);
      if (!cur || !n.price) continue;
      rows.push({
        symbol: n.symbol,
        move: ((cur.c - n.price) / n.price) * 100,
        mA: n.mA,
        mB: n.mB,
        mC: n.mC,
        mD: n.mD,
        curDate: new Date(cur.t * 1000).toISOString().slice(0, 10),
      });
    }
  } finally {
    await b.close();
  }
  if (rows.length < 3) {
    console.error('Not enough resolved names to grade.');
    process.exit(1);
  }

  const asof = rows[0].curDate;
  console.log(`Latest close used: ${asof}  ·  ${rows.length} names resolved\n`);

  const pad = (s, n) => String(s).padEnd(n).slice(0, n);
  console.log(pad('MODE', 14) + pad('Spearman', 11) + pad('top10 avg move', 16) + 'rest avg move');
  console.log('-'.repeat(60));
  const modes = [['A: increment', 'mA'], ['B: balanced', 'mB'], ['C: sustainable', 'mC'], ['D: refined', 'mD'], ['W: early', 'mW'], ['Z: consensus', 'mZ']];
  const results = [];
  for (const [label, key] of modes) {
    const valid = rows.filter((r) => r[key] != null);
    const rho = spearman(valid.map((r) => r[key]), valid.map((r) => r.move));
    const sorted = [...valid].sort((a, b) => b[key] - a[key]);
    const top10 = mean(sorted.slice(0, 10).map((r) => r.move));
    const rest = mean(sorted.slice(10).map((r) => r.move));
    results.push({ label, rho, top10, rest });
    console.log(
      pad(label, 14) +
        pad(rho == null ? 'n/a' : rho.toFixed(2), 11) +
        pad((top10 >= 0 ? '+' : '') + top10.toFixed(1) + '%', 16) +
        (rest >= 0 ? '+' : '') + rest.toFixed(1) + '%'
    );
  }
  const best = results.filter((r) => r.rho != null).sort((a, b) => b.rho - a.rho)[0];
  console.log(
    `\nBest predictor this day: ${best ? best.label : 'n/a'}` +
      (best ? `  (Spearman ${best.rho.toFixed(2)}, top-10 ${best.top10 >= 0 ? '+' : ''}${best.top10.toFixed(1)}%)` : '')
  );
  console.log('(one day = noise; needs several days before trusting the ranking)');
}

main().catch((e) => {
  console.error('✖ grade failed:', e.message);
  process.exit(1);
});
