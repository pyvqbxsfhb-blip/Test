// Pure scorecard helpers (no browser, no report) — shared leaf module so
// report.js and track.js can both use them without an import cycle.

import fs from 'fs';
import path from 'path';

export const TARGET_PCT = 11;
export const MAX_DAYS = 20; // trading days
export const MODE_KEYS = { A: 'mA', B: 'mB', C: 'mC', D: 'mD', W: 'mW', X: 'mX', Y: 'mY', Z: 'mZ' };
export const MODE_LIST = Object.keys(MODE_KEYS);

export function loadPositions(dir) {
  const p = path.join(dir, 'positions.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export function savePositions(dir, positions) {
  fs.writeFileSync(path.join(dir, 'positions.jsonl'), positions.map((p) => JSON.stringify(p)).join('\n') + '\n');
}

// Open each mode's #1 pick for every stored daily snapshot (idempotent).
export function seedFromSnapshots(dir, positions) {
  const files = fs.readdirSync(dir).filter((f) => /^daily-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  for (const f of files) {
    const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const names = rec.names || rec.ranking || [];
    for (const [mode, key] of Object.entries(MODE_KEYS)) {
      const valid = names.filter((r) => r[key] != null);
      if (!valid.length) continue;
      const top = valid.reduce((a, b) => (b[key] > a[key] ? b : a));
      if (positions.some((p) => p.mode === mode && p.entryDate === rec.date)) continue;
      positions.push({
        mode, symbol: top.symbol, entryDate: rec.date, entryPrice: top.price,
        score: top[key], status: 'open', peakPct: 0, lastPct: 0,
      });
    }
  }
  return positions;
}

export function computeScoreboard(positions) {
  const sb = {};
  for (const m of MODE_LIST) {
    const ps = positions.filter((p) => p.mode === m);
    const won = ps.filter((p) => p.status === 'won').length;
    const neutral = ps.filter((p) => p.status === 'neutral').length;
    const lost = ps.filter((p) => p.status === 'lost').length;
    const open = ps.filter((p) => p.status === 'open').length;
    const resolved = won + neutral + lost;
    const wonDays = ps.filter((p) => p.status === 'won' && p.daysToTarget != null).map((p) => p.daysToTarget);
    sb[m] = {
      points: ps.reduce((s, p) => s + (p.points || 0), 0),
      won, neutral, lost, open, resolved,
      winRate: resolved ? +(won / resolved).toFixed(2) : null,
      avgDaysToWin: wonDays.length ? +(wonDays.reduce((a, b) => a + b, 0) / wonDays.length).toFixed(1) : null,
    };
  }
  return sb;
}
