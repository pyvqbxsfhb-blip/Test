// Pure scorecard helpers (no browser, no report) — shared leaf module so
// report.js and track.js can both use them without an import cycle.

import fs from 'fs';
import path from 'path';

export const TARGET_PCT = 11;
export const MAX_DAYS = 20; // trading days
// You capture an overnight price but realistically fill ~5% higher at the open,
// so the assumed buy = capture * (1 + ENTRY_SLIP), and gains are measured from it.
export const ENTRY_SLIP = 0.05;
export const MODE_KEYS = { A: 'mA', B: 'mB', C: 'mC', D: 'mD', W: 'mW', X: 'mX', Y: 'mY', Z: 'mZ', S: 'mS' };
export const MODE_LIST = Object.keys(MODE_KEYS);
// The lean, genuinely-distinct set we actually TRACK (open positions / score):
// W thrust · S sustained (orthogonal) · Z consensus · X breakout.
// A/B/C/D/Y are still computed (Z's consensus base) but retired from tracking.
export const TRACKED_MODES = ['W', 'S', 'Z', 'X'];

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
    for (const mode of TRACKED_MODES) {
      const key = MODE_KEYS[mode];
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
  for (const m of TRACKED_MODES) {
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
