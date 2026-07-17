#!/usr/bin/env node
// Evidence check: for every scored name in the stored daily snapshots, measure
// realized PEAK upside since entry, and test which mode's score best predicts
// it (Spearman) + how the top-5 by each mode actually fared. Stored mA..mD are
// already as-of-entry; mW (early) is computed as-of-entry from truncated candles.
//
// Usage: node src/prove.js

import fs from 'fs';
import path from 'path';
import { launchBrowser, openSite, getDailyBars } from './tradingview.js';
import { momentumScore, assignConsensus } from './momentum.js';

const dir = path.resolve('snapshots');
const days = fs.readdirSync(dir).filter((f) => /^daily-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort()
  .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));

function spearman(a, b) {
  const rank = (arr) => { const idx = arr.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = []; idx.forEach(([, i], k) => (r[i] = k + 1)); return r; };
  const n = a.length; if (n < 3) return null;
  const ra = rank(a), rb = rank(b); let d = 0; for (let i = 0; i < n; i++) d += (ra[i] - rb[i]) ** 2;
  return 1 - (6 * d) / (n * (n * n - 1));
}
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);

async function candles(page, sym, cache) {
  if (cache.has(sym)) return cache.get(sym);
  const cs = sym.includes(':') ? [sym] : [`NASDAQ:${sym}`, `NYSE:${sym}`, `AMEX:${sym}`];
  let out = null; for (const f of cs) { const c = await getDailyBars(page, f, 60); if (c && c.length) { out = c; break; } }
  cache.set(sym, out); return out;
}

const MODES = [['A', 'mA'], ['B', 'mB'], ['C', 'mC'], ['D', 'mD'], ['W', 'mW'], ['X', 'mX'], ['Y', 'mY'], ['Z', 'mZ']];

async function main() {
  const b = await launchBrowser();
  const rows = [];
  try {
    const page = await openSite(b);
    const cache = new Map();
    for (const day of days) {
      const entEnd = Date.parse(day.date + 'T23:59:59Z') / 1000;
      const entStart = Date.parse(day.date + 'T00:00:00Z') / 1000;
      for (const n of day.names || []) {
        const c = await candles(page, n.symbol, cache);
        if (!c || !n.price) continue;
        const fwd = c.filter((x) => x.t >= entStart);
        if (!fwd.length) continue;
        const peakFwd = +((Math.max(...fwd.map((x) => x.h ?? x.c)) / n.price - 1) * 100).toFixed(1);
        const asOf = c.filter((x) => x.t <= entEnd);
        const ok = asOf.length >= 20;
        const mW = ok ? momentumScore(asOf, 'early').score : null;
        const mX = ok ? momentumScore(asOf, 'breakout').score : null;
        const mY = ok ? momentumScore(asOf, 'pullback').score : null;
        rows.push({ date: day.date, symbol: n.symbol, mA: n.mA, mB: n.mB, mC: n.mC, mD: n.mD, mW, mX, mY, peakFwd, hit: peakFwd >= 11 });
      }
      assignConsensus(rows.filter((r) => r.date === day.date)); // sets mZ per day
      process.stderr.write(`  ${day.date}: ${rows.filter((r) => r.date === day.date).length} names\n`);
    }
  } finally { await b.close(); }

  console.log(`\nEvidence over ${days.length} days, ${rows.length} name-observations (peak upside since entry):\n`);
  const pad = (s, n) => String(s).padEnd(n).slice(0, n);
  console.log(pad('MODE', 6) + pad('Spearman', 11) + pad('top5 peak', 12) + pad('top5 hit>11%', 14) + 'rest peak');
  console.log('-'.repeat(60));
  const res = [];
  for (const [label, key] of MODES) {
    const valid = rows.filter((r) => r[key] != null);
    if (valid.length < 3) { console.log(pad(label, 6) + 'insufficient'); continue; }
    const rho = spearman(valid.map((r) => r[key]), valid.map((r) => r.peakFwd));
    // top-5 by mode within each day, pooled
    const top = [], rest = [];
    for (const day of days) {
      const dr = valid.filter((r) => r.date === day.date).sort((a, b) => b[key] - a[key]);
      top.push(...dr.slice(0, 5)); rest.push(...dr.slice(5));
    }
    const hit = top.filter((r) => r.hit).length;
    res.push({ label, rho, topPeak: mean(top.map((r) => r.peakFwd)), restPeak: mean(rest.map((r) => r.peakFwd)), hit, topN: top.length });
    console.log(pad(label, 6) + pad(rho == null ? '—' : rho.toFixed(2), 11) + pad('+' + mean(top.map((r) => r.peakFwd)).toFixed(1) + '%', 12) + pad(`${hit}/${top.length}`, 14) + '+' + mean(rest.map((r) => r.peakFwd)).toFixed(1) + '%');
  }
  const best = res.filter((r) => r.rho != null).sort((a, b) => b.rho - a.rho)[0];
  console.log(`\nBest-predicting mode over these ${days.length} days: ${best ? best.label : 'n/a'}` + (best ? ` (Spearman ${best.rho.toFixed(2)}, top-5 peak +${best.topPeak.toFixed(1)}%, ${best.hit}/${best.topN} hit +11%)` : ''));
  console.log('(3 days is thin — directional evidence, not proof.)');
}
main().catch((e) => { console.error('✖ prove failed:', e.message); process.exit(1); });
