#!/usr/bin/env node
// Build a self-contained HTML report from the stored daily snapshots.
// Ranks by Mode D (refined) — the recommendation — with a top-picks callout,
// an A/B/C/D table, and a score-trend chart once >=2 days exist.
// Exported as buildReport() so daily.js can always regenerate it.

import fs from 'fs';
import path from 'path';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sg = (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + v);

// primary score for ranking: prefer D, then A, then legacy .score
function normalize(rec) {
  const names = (rec.names || rec.ranking || []).map((r) => ({
    ...r,
    score: r.mD != null ? r.mD : r.mA != null ? r.mA : r.score,
  }));
  return { ...rec, names };
}

function barChart(rows) {
  const W = 900, rowH = 26, padL = 150, padR = 60, padT = 8, padB = 8;
  const H = padT + padB + rows.length * rowH;
  const scores = rows.map((r) => r.score);
  const lo = Math.min(0, ...scores), hi = Math.max(0, ...scores);
  const plotW = W - padL - padR;
  const x = (v) => padL + ((v - lo) / (hi - lo || 1)) * plotW;
  const x0 = x(0);
  const bars = rows
    .map((r, i) => {
      const y = padT + i * rowH + 4, bh = rowH - 8, xv = x(r.score);
      const bx = Math.min(x0, xv), bw = Math.abs(xv - x0);
      const fill = r.score >= 0 ? 'var(--pos)' : 'var(--neg)';
      const tip = `${r.symbol}  D ${sg(r.mD)}  A ${sg(r.mA)}  $${(r.price ?? 0).toFixed(2)}  ${(r.changePct >= 0 ? '+' : '')}${(r.changePct ?? 0).toFixed(1)}%`;
      return `<g class="bar"><title>${esc(tip)}</title>
        <text x="${padL - 10}" y="${y + bh / 2}" class="lbl tk" text-anchor="end" dominant-baseline="central">${esc(r.symbol)}</text>
        <rect x="${bx.toFixed(1)}" y="${y}" width="${Math.max(2, bw).toFixed(1)}" height="${bh}" rx="4" fill="${fill}"/>
        <text x="${(xv + (r.score >= 0 ? 6 : -6)).toFixed(1)}" y="${y + bh / 2}" class="val" text-anchor="${r.score >= 0 ? 'start' : 'end'}" dominant-baseline="central">${sg(r.score)}</text>
      </g>`;
    })
    .join('\n');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Momentum score ranking (Mode D)">
    <line x1="${x0}" y1="${padT}" x2="${x0}" y2="${H - padB}" class="axis"/>${bars}</svg>`;
}

function trendChart(days, latest) {
  if (days.length < 2) return '';
  const dates = days.map((d) => d.date);
  const track = [...latest.names].sort((a, b) => b.score - a.score).slice(0, 8).map((r) => r.symbol);
  const byDay = days.map((d) => new Map(d.names.map((r) => [r.symbol, r.score])));
  const W = 900, H = 320, padL = 44, padR = 90, padT = 16, padB = 28;
  const all = days.flatMap((d) => d.names.map((r) => r.score));
  const lo = Math.min(...all, 0), hi = Math.max(...all);
  const x = (i) => padL + (i / (dates.length - 1 || 1)) * (W - padL - padR);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo || 1)) * (H - padT - padB);
  const cats = ['#2a78d6', '#1baf7a', '#eda100', '#008300', '#4a3aa7', '#e34948', '#e87ba4', '#eb6834'];
  const lines = track
    .map((sym, k) => {
      const pts = dates.map((_, i) => (byDay[i].has(sym) ? `${x(i).toFixed(1)},${y(byDay[i].get(sym)).toFixed(1)}` : null)).filter(Boolean);
      if (!pts.length) return '';
      const last = byDay[dates.length - 1].get(sym);
      return `<polyline points="${pts.join(' ')}" fill="none" stroke="${cats[k % 8]}" stroke-width="2"/>${last != null ? `<circle cx="${x(dates.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="3" fill="${cats[k % 8]}"/><text x="${W - padR + 6}" y="${y(last)}" class="lbl" dominant-baseline="central" fill="${cats[k % 8]}">${esc(sym)}</text>` : ''}`;
    })
    .join('\n');
  const xlabels = dates.map((d, i) => `<text x="${x(i)}" y="${H - 8}" class="lbl" text-anchor="middle">${esc(d.slice(5))}</text>`).join('');
  return `<h2>Score trend — Mode D top names (${days.length} days)</h2>
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Score trend over days">${lines}${xlabels}</svg>`;
}

function table(rows) {
  const body = rows
    .map((r, i) => `<tr><td>${i + 1}</td><td class="mono">${esc(r.symbol)}</td><td class="num d">${sg(r.mD)}</td><td class="num">${sg(r.mA)}</td><td class="num">${sg(r.mB)}</td><td class="num">${sg(r.mC)}</td><td class="num">$${(r.price ?? 0).toFixed(2)}</td><td class="num">${(r.changePct >= 0 ? '+' : '')}${(r.changePct ?? 0).toFixed(1)}%</td><td>${esc(r.sector || '')}</td></tr>`)
    .join('\n');
  return `<table><thead><tr><th>#</th><th>Ticker</th><th>D</th><th>A</th><th>B</th><th>C</th><th>Price</th><th>Chg</th><th>Sector</th></tr></thead><tbody>${body}</tbody></table>`;
}

function recommendation(rows) {
  const picks = rows.slice(0, 5);
  const cards = picks
    .map((r) => `<div class="rec"><span class="rt">${esc(r.symbol)}</span><span class="rs">D ${sg(r.mD)}</span><span class="rp">$${(r.price ?? 0).toFixed(2)} · ${esc(r.sector || '')}</span></div>`)
    .join('');
  return `<div class="reco"><h2 style="margin-top:0">★ Recommendation — top 5 by Mode D</h2><div class="recrow">${cards}</div>
    <p class="sub" style="margin:8px 0 0">Mode D = A's increment quality + graduated exhaustion cap. Screening aid, not investment advice — confirm live prices and catalyst before acting.</p></div>`;
}

export function buildReport(dir = path.resolve('snapshots')) {
  const days = fs
    .readdirSync(dir)
    .filter((f) => /^daily-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .map((f) => normalize(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))));
  if (!days.length) throw new Error('No snapshots/daily-*.json found. Run: node src/daily.js');

  const latest = days[days.length - 1];
  const ranked = [...latest.names].sort((a, b) => b.score - a.score).slice(0, 20);

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Daily momentum ranking — ${esc(latest.date)}</title></head>
<body style="margin:0;background:#f4f4f2"><div class="viz-root">
<style>
  .viz-root{color-scheme:light;--surface:#fcfcfb;--ink:#0b0b0b;--muted:#52514e;--grid:#e5e4e0;--pos:#2a78d6;--neg:#e34948;--card:#f0f4fb;
    background:var(--surface);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:20px;border-radius:10px}
  @media(prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .viz-root{--surface:#1a1a19;--ink:#fff;--muted:#c3c2b7;--grid:#333;--pos:#3987e5;--neg:#e66767;--card:#20293a}}
  :root[data-theme="dark"] .viz-root{--surface:#1a1a19;--ink:#fff;--muted:#c3c2b7;--grid:#333;--pos:#3987e5;--neg:#e66767;--card:#20293a}
  .viz-root h1{font-size:18px;margin:0 0 2px} .viz-root h2{font-size:14px;color:var(--muted);font-weight:600;margin:22px 0 6px}
  .viz-root .sub{color:var(--muted);margin:0 0 14px;font-size:12px}
  .viz-root svg{max-width:100%;background:var(--surface)}
  .viz-root .axis{stroke:var(--muted);stroke-width:1}
  .viz-root .lbl{fill:var(--muted);font-size:11px} .viz-root .tk{fill:var(--ink);font-weight:600;font-size:12px}
  .viz-root .val{fill:var(--ink);font-size:11px;font-weight:600} .viz-root .bar:hover rect{stroke:var(--ink);stroke-width:1.5}
  .viz-root .reco{background:var(--card);border-radius:10px;padding:14px 16px;margin:6px 0 4px}
  .viz-root .recrow{display:flex;flex-wrap:wrap;gap:10px} .viz-root .rec{display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--grid);border-radius:8px;padding:8px 12px;min-width:120px}
  .viz-root .rt{font-weight:700;font-size:15px} .viz-root .rs{color:var(--pos);font-weight:700;font-size:12px} .viz-root .rp{color:var(--muted);font-size:11px}
  .viz-root table{border-collapse:collapse;width:100%;margin-top:8px;font-size:12px}
  .viz-root th,.viz-root td{padding:4px 8px;border-bottom:1px solid var(--grid);text-align:left}
  .viz-root th{color:var(--muted);font-weight:600} .viz-root .num,.viz-root .mono{text-align:right;font-variant-numeric:tabular-nums}
  .viz-root .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;text-align:left;font-weight:600} .viz-root td.d{color:var(--pos);font-weight:700}
</style>
<h1>Daily momentum ranking — ${esc(latest.date)}</h1>
<p class="sub">Ranked by Mode D (refined) · A/B/C/D in table · ${latest.count ?? ranked.length} names ($500M–$50B) · price-only · not investment advice</p>
${recommendation(ranked)}
<h2>Top 20 by Mode D score</h2>
${barChart(ranked)}
${trendChart(days, latest)}
<h2>Table — all four modes</h2>
${table(ranked)}
</div></body></html>`;

  const out = path.join(dir, 'report.html');
  fs.writeFileSync(out, html);
  return { out, days: days.length, latest: latest.date };
}

// CLI
if (process.argv[1] && process.argv[1].endsWith('report.js')) {
  const r = buildReport();
  console.log(`Wrote ${r.out}  (${r.days} day(s), latest ${r.latest})`);
}
