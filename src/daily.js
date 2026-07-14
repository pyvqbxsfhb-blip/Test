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
import { DEFAULTS } from './config.js';

function parse(argv) {
  const o = { top: 20, enrich: 45, mode: 'increment', date: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--top') o.top = Number(argv[++i]);
    else if (a === '--enrich') o.enrich = Number(argv[++i]);
    else if (a === '--mode') o.mode = argv[++i];
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
    process.stderr.write(`▶ scoring top ${pool.length} by momentum …\n`);
    const scored = [];
    for (const r of pool) {
      const candles = await getDailyBars(page, r.fullSymbol, 60);
      if (!candles || candles.length < 20) continue;
      scored.push({
        symbol: r.symbol,
        score: momentumScore(candles, o.mode).score,
        price: r.price,
        changePct: r.changePct,
        marketCap: r.marketCap,
        sector: r.sector,
      });
    }
    scored.sort((a, b) => b.score - a.score);
    ranked = scored.slice(0, o.top).map((r, i) => ({ rank: i + 1, ...r }));
  } finally {
    await b.close();
  }

  const record = { date, capturedAt, scoreMode: o.mode, count: ranked.length, ranking: ranked };
  const dailyPath = path.join(dir, `daily-${date}.json`);
  fs.writeFileSync(dailyPath, JSON.stringify(record, null, 2));

  // Append to the time-series log (idempotent per date: drop existing lines for this date first).
  const histPath = path.join(dir, 'history.jsonl');
  let lines = fs.existsSync(histPath)
    ? fs.readFileSync(histPath, 'utf8').split('\n').filter((l) => l && !l.includes(`"date":"${date}"`))
    : [];
  for (const r of ranked)
    lines.push(JSON.stringify({ date, symbol: r.symbol, rank: r.rank, score: r.score, price: r.price }));
  fs.writeFileSync(histPath, lines.join('\n') + '\n');

  // Minimal ranked output (no commentary).
  const pad = (s, n) => String(s).padEnd(n).slice(0, n);
  console.log(`# ${date}  (mode ${o.mode})  -> ${dailyPath}`);
  console.log(pad('RANK', 6) + pad('TICKER', 8) + pad('SCORE', 8) + pad('PRICE', 10) + 'CHG%');
  for (const r of ranked)
    console.log(
      pad(r.rank, 6) +
        pad(r.symbol, 8) +
        pad((r.score >= 0 ? '+' : '') + r.score, 8) +
        pad('$' + (r.price ?? 0).toFixed(2), 10) +
        (r.changePct >= 0 ? '+' : '') + (r.changePct ?? 0).toFixed(1)
    );
}

main().catch((e) => {
  console.error('✖ daily failed:', e.message);
  process.exit(1);
});
