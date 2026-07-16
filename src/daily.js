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
import { momentumScore, assignConsensus } from './momentum.js';
import { buildReport } from './report.js';
import { loadPositions, seedFromSnapshots, resolvePositions, savePositions, computeScoreboard } from './track.js';
import { MODE_LIST } from './scorecard.js';
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
  let scoreboard = {};
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
        mW: momentumScore(candles, 'early').score,
      });
    }
    assignConsensus(scored); // Mode Z (meta) from the base-mode scores
    scored.sort((a, b) => b.mW - a.mW); // stored order by W (proven / recommendation mode)
    ranked = scored;

    // ---- persist today's record + time series ----
    const record = {
      date, capturedAt, band: '500M-50B',
      modes: { A: 'increment', B: 'balanced', C: 'sustainable', D: 'refined', W: 'early', Z: 'consensus' },
      count: ranked.length, names: ranked,
    };
    fs.writeFileSync(path.join(dir, `daily-${date}.json`), JSON.stringify(record, null, 2));
    const histPath = path.join(dir, 'history.jsonl');
    let lines = fs.existsSync(histPath)
      ? fs.readFileSync(histPath, 'utf8').split('\n').filter((l) => l && !l.includes(`"date":"${date}"`))
      : [];
    for (const r of ranked)
      lines.push(JSON.stringify({ date, symbol: r.symbol, price: r.price, mA: r.mA, mB: r.mB, mC: r.mC, mD: r.mD, mW: r.mW, mZ: r.mZ }));
    fs.writeFileSync(histPath, lines.join('\n') + '\n');

    // ---- mode scorecard: open each mode's #1 pick, resolve open positions ----
    process.stderr.write('▶ updating mode scorecard (target +11% / 20d) …\n');
    const positions = seedFromSnapshots(dir, loadPositions(dir));
    await resolvePositions(page, positions);
    savePositions(dir, positions);
    scoreboard = computeScoreboard(positions);
  } finally {
    await b.close();
  }

  const dailyPath = path.join(dir, `daily-${date}.json`);
  // Always (re)generate the report (recommendation + scorecard).
  const rep = buildReport(dir);

  // Minimal output: top-N by each mode (no commentary).
  const pad = (s, n) => String(s).padEnd(n).slice(0, n);
  const topBy = (key) => [...ranked].sort((a, b) => b[key] - a[key]).slice(0, o.top);
  console.log(`# ${date}  (${ranked.length} names, $500M-$50B)  -> ${dailyPath}`);
  console.log(`# report -> ${rep.out}`);
  console.log(pad('RANK', 5) + pad('W:early★', 14) + pad('D:refined', 14) + pad('A:incr', 14) + pad('B:bal', 14) + 'C:sust');
  const W = topBy('mW'), D = topBy('mD'), A = topBy('mA'), B = topBy('mB'), C = topBy('mC');
  const fmt = (r, k) => (r ? `${r.symbol} ${r[k] >= 0 ? '+' : ''}${r[k]}` : '');
  for (let i = 0; i < o.top; i++)
    console.log(pad(i + 1, 5) + pad(fmt(W[i], 'mW'), 14) + pad(fmt(D[i], 'mD'), 14) + pad(fmt(A[i], 'mA'), 14) + pad(fmt(B[i], 'mB'), 14) + fmt(C[i], 'mC'));

  console.log('\n# mode scorecard (target +11% / 20d)');
  console.log(pad('MODE', 6) + pad('PTS', 6) + pad('W', 4) + pad('N', 4) + pad('L', 4) + 'OPEN');
  for (const m of MODE_LIST) {
    const s = scoreboard[m] || { points: 0, won: 0, neutral: 0, lost: 0, open: 0 };
    console.log(pad(m, 6) + pad((s.points >= 0 ? '+' : '') + s.points, 6) + pad(s.won, 4) + pad(s.neutral, 4) + pad(s.lost, 4) + s.open);
  }
}

main().catch((e) => {
  console.error('✖ daily failed:', e.message);
  process.exit(1);
});
