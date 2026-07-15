#!/usr/bin/env node
// Daily runner: scan live gainers, score each by momentum, persist a dated
// record, and print the top-N ranked tickers. Designed to run once per day so
// the snapshots/ history builds a time series for later graphing/analysis.
//
// Usage: node src/daily.js [--top 20] [--enrich 45] [--mode increment] [--date YYYY-MM-DD]
//
// Writes:
//   snapshots/daily-<date>.json   full ranked record for the day
//   snapshots/history.jsonl       one line per (date,ticker) for time-series

import fs from 'fs';
import path from 'path';
import { launchBrowser, openSite, scanGainers, getDailyBars } from './tradingview.js';
import { momentumScore } from './momentum.js';
import { buildReport } from './report.js';
import { DEFAULTS } from './config.js';

const MODES = ['increment', 'balanced', 'sustainable']; // A, B, C

function parse(argv) {
  const o = { top: 20, enrich: 55, date: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--top') o.top = Number(argv[++i]);
    else if (a === '--enrich') o.enrich = Number(argv[++i]);
    else if (a === '--date') o.date = argv[++i];
  }
  return o;
}

async function main() {
  const o = parse(process.argv);
  const date = o.date || new Date().toISOString().slice(0, 10);
  const capturedAt = new Date().toISOString();
  const dir = path.resolve('snapshots');
  fs.mkdirSync(dir, { recursive: true });

  const b = await launchBrowser();
  let ranked = [];
  try {
    const page = await openSite(b);
    process.stderr.write('▶ scanning live gainers …\n');
    const { rows } = await scanGainers(page, { ...DEFAULTS, scanSize: 300 });
    // Keep your $500M-$50B hard-rule band (screens sub-$500M pump/halt traps).
    const sized = rows.filter(
      (r) => r.marketCap >= DEFAULTS.marketCapMin && r.marketCap <= DEFAULTS.marketCapMax
    );
    const pool = sized.slice(0, o.enrich); // highest-change in-band names to score
    process.stderr.write(`▶ scoring top ${pool.length} in all 4 modes (A/B/C/D) …\n`);
    const scored = [];
    for (const r of pool) {
      const candles = await getDailyBars(page, r.fullSymbol, 60);
      if (!candles || candles.length < 20) continue;
      scored.push({
        symbol: r.symbol,
        price: r.price,
        changePct: r.changePct,
        marketCap: r.marketCap,
        sector: r.sector,
        mA: momentumScore(candles, 'increment').score,
        mB: momentumScore(candles, 'balanced').score,
        mC: momentumScore(candles, 'sustainable').score,
        mD: momentumScore(candles, 'refined').score,
      });
    }
    scored.sort((a, b) => b.mD - a.mD); // stored order by D (recommendation mode)
    ranked = scored;
  } finally {
    await b.close();
  }

  const record = {
    date,
    capturedAt,
    band: '500M-50B',
    modes: { A: 'increment', B: 'balanced', C: 'sustainable' },
    count: ranked.length,
    names: ranked,
  };
  const dailyPath = path.join(dir, `daily-${date}.json`);
  fs.writeFileSync(dailyPath, JSON.stringify(record, null, 2));

  // Time-series log — all 3 scores per (date,ticker). Idempotent per date.
  const histPath = path.join(dir, 'history.jsonl');
  let lines = fs.existsSync(histPath)
    ? fs.readFileSync(histPath, 'utf8').split('\n').filter((l) => l && !l.includes(`"date":"${date}"`))
    : [];
  for (const r of ranked)
    lines.push(JSON.stringify({ date, symbol: r.symbol, price: r.price, mA: r.mA, mB: r.mB, mC: r.mC, mD: r.mD }));
  fs.writeFileSync(histPath, lines.join('\n') + '\n');

  // Always (re)generate the report with the recommendation.
  const rep = buildReport(dir);

  // Minimal output: top-N by each mode (no commentary).
  const pad = (s, n) => String(s).padEnd(n).slice(0, n);
  const topBy = (key) => [...ranked].sort((a, b) => b[key] - a[key]).slice(0, o.top);
  console.log(`# ${date}  (${ranked.length} names, $500M-$50B)  -> ${dailyPath}`);
  console.log(`# report -> ${rep.out}`);
  console.log(pad('RANK', 5) + pad('D:refined', 15) + pad('A:incr', 15) + pad('B:balanced', 15) + 'C:sustainable');
  const D = topBy('mD'), A = topBy('mA'), B = topBy('mB'), C = topBy('mC');
  const fmt = (r, k) => (r ? `${r.symbol} ${r[k] >= 0 ? '+' : ''}${r[k]}` : '');
  for (let i = 0; i < o.top; i++)
    console.log(pad(i + 1, 5) + pad(fmt(D[i], 'mD'), 15) + pad(fmt(A[i], 'mA'), 15) + pad(fmt(B[i], 'mB'), 15) + fmt(C[i], 'mC'));
}

main().catch((e) => {
  console.error('✖ daily failed:', e.message);
  process.exit(1);
});
