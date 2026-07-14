#!/usr/bin/env node
// Build a self-contained HTML report from the stored daily snapshots.
// Latest day -> ranked score bar chart; >=2 days -> score-trend lines for
// recurring names. Plus a data table. Theme-aware, no external assets.
//
// Usage: node src/report.js  ->  writes snapshots/report.html

import fs from 'fs';
import path from 'path';

const dir = path.resolve('snapshots');
const days = fs
  .readdirSync(dir)
  .filter((f) => /^daily-\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .sort()
  .map((f) => normalize(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))));

if (!days.length) {
  console.error('No snapshots/daily-*.json found. Run: node src/daily.js');
  process.exit(1);
}

const latest = days[days.length - 1];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Back-compat: normalise a record's names and pick primary (A) score.
function normalize(rec) {
  const names = (rec.names || rec.ranking || []).map((r) => ({
    ...r,
    score: r.mA != null ? r.mA : r.score,
  }));
  return { ...rec, names };
}

// ---- ranked bar chart (latest day), server-rendered SVG ----
function barChart(rec) {
  const rows = [...rec.names].sort((a, b) => b.score - a.score).slice(0, 20);
  const W = 900, rowH = 26, padL = 150, padR = 60, padT = 8, padB = 8;
  const H = padT + padB + rows.length * rowH;
  const scores = rows.map((r) => r.score);
  const lo = Math.min(0, ...scores), hi = Math.max(0, ...scores);
  const plotW = W - padL - padR;
  const x = (v) => padL + ((v - lo) / (hi - lo || 1)) * plotW;
  const x0 = x(0);
  const bars = rows
    .map((r, i) => {
      const y = padT + i * rowH + 4;
      const bh = rowH - 8;
      const xv = x(r.score);
      const bx = Math.min(x0, xv), bw = Math.abs(xv - x0);
      const fill = r.score >= 0 ? 'var(--pos)' : 'var(--neg)';
      const tip = `${r.symbol}  score ${r.score}  $${(r.price ?? 0).toFixed(2)}  ${(r.changePct >= 0 ? '+' : '')}${(r.changePct ?? 0).toFixed(1)}%`;
      return `<g class="bar"><title>${esc(tip)}</title>
        <text x="${padL - 10}" y="${y + bh / 2}" class="lbl tk" text-anchor="end" dominant-baseline="central">${esc(r.symbol)}</text>
        <rect x="${bx.toFixed(1)}" y="${y}" width="${Math.max(2, bw).toFixed(1)}" height="${bh}" rx="4" fill="${fill}"/>
        <text x="${(xv + (r.score >= 0 ? 6 : -6)).toFixed(1)}" y="${y + bh / 2}" class="val" text-anchor="${r.score >= 0 ? 'start' : 'end'}" dominant-baseline="central">${r.score >= 0 ? '+' : ''}${r.score}</text>
      </g>`;
    })
    .join('\n');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Momentum score ranking">
    <line x1="${x0}" y1="${padT}" x2="${x0}" y2="${H - padB}" class="axis"/>
    ${bars}
  </svg>`;
}

// ---- score-trend lines (>=2 days) for names present on the latest day ----
function trendChart(days) {
  if (days.length < 2) return '';
  const dates = days.map((d) => d.date);
  const track = latest.names.slice(0, 8).map((r) => r.symbol); // top 8 to keep readable
  const byDay = days.map((d) => new Map(d.names.map((r) => [r.symbol, r.score])));
  const W = 900, H = 320, padL = 44, padR = 90, padT = 16, padB = 28;
  const allScores = days.flatMap((d) => d.names.map((r) => r.score));
  const lo = Math.min(...allScores, 0), hi = Math.max(...allScores);
  const x = (i) => padL + (i / (dates.length - 1 || 1)) * (W - padL - padR);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo || 1)) * (H - padT - padB);
  const cats = ['#2a78d6', '#1baf7a', '#eda100', '#008300', '#4a3aa7', '#e34948', '#e87ba4', '#eb6834'];
  const lines = track
    .map((sym, k) => {
      const pts = dates
        .map((_, i) => (byDay[i].has(sym) ? `${x(i).toFixed(1)},${y(byDay[i].get(sym)).toFixed(1)}` : null))
        .filter(Boolean);
      if (pts.length < 1) return '';
      const last = byDay[dates.length - 1].get(sym);
      return `<polyline points="${pts.join(' ')}" fill="none" stroke="${cats[k % 8]}" stroke-width="2"/>
        ${last != null ? `<text x="${W - padR + 6}" y="${y(last)}" class="lbl" dominant-baseline="central" fill="${cats[k % 8]}">${esc(sym)}</text>` : ''}`;
    })
    .join('\n');
  const xlabels = dates.map((d, i) => `<text x="${x(i)}" y="${H - 8}" class="lbl" text-anchor="middle">${esc(d.slice(5))}</text>`).join('');
  return `<h2>Score trend — top names (${days.length} days)</h2>
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Score trend over days">
      ${lines}${xlabels}
    </svg>`;
}

const sg = (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + v);
function table(rec) {
  const rows = [...rec.names]
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map(
      (r, i) =>
        `<tr><td>${i + 1}</td><td class="mono">${esc(r.symbol)}</td><td class="num a">${sg(r.mA)}</td><td class="num">${sg(r.mB)}</td><td class="num">${sg(r.mC)}</td><td class="num">$${(r.price ?? 0).toFixed(2)}</td><td class="num">${(r.changePct >= 0 ? '+' : '')}${(r.changePct ?? 0).toFixed(1)}%</td><td>${esc(r.sector || '')}</td></tr>`
    )
    .join('\n');
  return `<table><thead><tr><th>#</th><th>Ticker</th><th>A</th><th>B</th><th>C</th><th>Price</th><th>Chg</th><th>Sector</th></tr></thead><tbody>${rows}</tbody></table>`;
}

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Daily momentum ranking — ${esc(latest.date)}</title></head>
<body style="margin:0;background:#f4f4f2">
<div class="viz-root">
<style>
  .viz-root{color-scheme:light;--surface:#fcfcfb;--ink:#0b0b0b;--muted:#52514e;--grid:#e5e4e0;--pos:#2a78d6;--neg:#e34948;
    background:var(--surface);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:20px;border-radius:10px}
  @media(prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .viz-root{--surface:#1a1a19;--ink:#fff;--muted:#c3c2b7;--grid:#333;--pos:#3987e5;--neg:#e66767}}
  :root[data-theme="dark"] .viz-root{--surface:#1a1a19;--ink:#fff;--muted:#c3c2b7;--grid:#333;--pos:#3987e5;--neg:#e66767}
  .viz-root h1{font-size:18px;margin:0 0 2px} .viz-root h2{font-size:14px;color:var(--muted);font-weight:600;margin:22px 0 6px}
  .viz-root .sub{color:var(--muted);margin:0 0 14px;font-size:12px}
  .viz-root svg{max-width:100%;background:var(--surface)}
  .viz-root .axis{stroke:var(--muted);stroke-width:1}
  .viz-root .lbl{fill:var(--muted);font-size:11px} .viz-root .tk{fill:var(--ink);font-weight:600;font-size:12px}
  .viz-root .val{fill:var(--ink);font-size:11px;font-weight:600}
  .viz-root .bar:hover rect{stroke:var(--ink);stroke-width:1.5}
  .viz-root table{border-collapse:collapse;width:100%;margin-top:14px;font-size:12px}
  .viz-root th,.viz-root td{padding:4px 8px;border-bottom:1px solid var(--grid);text-align:left}
  .viz-root th{color:var(--muted);font-weight:600} .viz-root .num,.viz-root .mono{text-align:right;font-variant-numeric:tabular-nums}
  .viz-root .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;text-align:left;font-weight:600}
  .viz-root td.a{color:var(--pos);font-weight:700}
</style>
<h1>Daily momentum ranking — ${esc(latest.date)}</h1>
<p class="sub">Ranked by Mode A (increment) · A/B/C scores in table · ${latest.count} names ($500M–$50B) · price-only · not investment advice</p>
<h2>Top 20 by Mode A score</h2>
${barChart(latest)}
${trendChart(days)}
<h2>Table</h2>
${table(latest)}
</div></body></html>`;

const out = path.join(dir, 'report.html');
fs.writeFileSync(out, html);
console.log(`Wrote ${out}  (${days.length} day(s), latest ${latest.date})`);
