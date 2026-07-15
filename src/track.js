#!/usr/bin/env node
// Browser-dependent scorecard resolver + CLI. Pure helpers live in scorecard.js.
//
//   * peak (intraday high) >= +TARGET% from entry  -> WON  (+1), close
//   * else at MAX_DAYS trading days: last close > 0 -> NEUTRAL (0); <= 0 -> LOST (-1)
//
// CLI:  node src/track.js   (seed from snapshots + resolve, no live scan)

import path from 'path';
import { getDailyBars } from './tradingview.js';
import {
  TARGET_PCT, MAX_DAYS, loadPositions, savePositions, seedFromSnapshots, computeScoreboard,
} from './scorecard.js';

export { loadPositions, savePositions, seedFromSnapshots, computeScoreboard, TARGET_PCT, MAX_DAYS };

const isoDate = (t) => new Date(t * 1000).toISOString().slice(0, 10);

async function candlesFor(page, symbol, cache) {
  if (cache.has(symbol)) return cache.get(symbol);
  const cands = symbol.includes(':') ? [symbol] : [`NASDAQ:${symbol}`, `NYSE:${symbol}`, `AMEX:${symbol}`];
  let out = null;
  for (const full of cands) {
    const c = await getDailyBars(page, full, 40);
    if (c && c.length) { out = c; break; }
  }
  cache.set(symbol, out);
  return out;
}

// Resolve open positions against latest candles.
export async function resolvePositions(page, positions) {
  const cache = new Map();
  for (const pos of positions) {
    if (pos.status !== 'open') continue;
    const candles = await candlesFor(page, pos.symbol, cache);
    if (!candles) continue;
    const entT = Date.parse(pos.entryDate + 'T00:00:00Z') / 1000;
    const since = candles.filter((c) => c.t >= entT);
    if (!since.length || !pos.entryPrice) continue;
    const peakHigh = Math.max(...since.map((c) => c.h ?? c.c));
    const lastClose = since[since.length - 1].c;
    pos.peakPct = +((peakHigh / pos.entryPrice - 1) * 100).toFixed(1);
    pos.lastPct = +((lastClose / pos.entryPrice - 1) * 100).toFixed(1);
    pos.barsHeld = since.length - 1; // trading days after entry
    if (pos.peakPct >= TARGET_PCT) {
      pos.status = 'won'; pos.points = 1; pos.resolvedDate = isoDate(since[since.length - 1].t);
    } else if (pos.barsHeld >= MAX_DAYS) {
      if (pos.lastPct > 0) { pos.status = 'neutral'; pos.points = 0; }
      else { pos.status = 'lost'; pos.points = -1; }
      pos.resolvedDate = isoDate(since[since.length - 1].t);
    }
  }
  return positions;
}

// CLI
if (process.argv[1] && process.argv[1].endsWith('track.js')) {
  const { launchBrowser, openSite } = await import('./tradingview.js');
  const { buildReport } = await import('./report.js');
  const dir = path.resolve('snapshots');
  const positions = seedFromSnapshots(dir, loadPositions(dir));
  const b = await launchBrowser();
  try {
    const page = await openSite(b);
    await resolvePositions(page, positions);
  } finally { await b.close(); }
  savePositions(dir, positions);
  buildReport(dir);
  const sb = computeScoreboard(positions);
  const pad = (s, n) => String(s).padEnd(n).slice(0, n);
  console.log(`\nMode scorecard (target +${TARGET_PCT}% within ${MAX_DAYS}d):`);
  console.log(pad('MODE', 7) + pad('POINTS', 8) + pad('W', 4) + pad('N', 4) + pad('L', 4) + pad('OPEN', 6) + 'winRate');
  for (const m of ['A', 'B', 'C', 'D']) {
    const s = sb[m];
    console.log(pad(m, 7) + pad((s.points >= 0 ? '+' : '') + s.points, 8) + pad(s.won, 4) + pad(s.neutral, 4) + pad(s.lost, 4) + pad(s.open, 6) + (s.winRate == null ? '—' : s.winRate));
  }
}
