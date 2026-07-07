// Human-readable output helpers.

export function fmtCap(v) {
  if (!Number.isFinite(v)) return '—';
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  return `$${v.toFixed(0)}`;
}

export function fmtPct(v) {
  if (!Number.isFinite(v)) return '—';
  const s = v >= 0 ? '+' : '';
  return `${s}${v.toFixed(1)}%`;
}

function fmtPrice(v) {
  return Number.isFinite(v) ? `$${v.toFixed(2)}` : '—';
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

function trendTag(r) {
  const legs = [];
  if (r.nearHigh) legs.push('52w-high');
  if (r.upDaysSource === 'daily-bars' && r.upDays != null)
    legs.push(`${r.upDays}d-up`);
  else if (r.consecUpLeg) legs.push('wk-up~');
  if (r.inAntiPumpBand) legs.push('anti-pump');
  return legs.join(',') || '—';
}

export function renderTable(survivors, cfg, meta) {
  const lines = [];
  lines.push('');
  lines.push(
    `TradingView live top gainers — ${meta.mode} ranking  (scanned ${meta.scanned}, ` +
      `${survivors.length} survived pipeline)`
  );
  lines.push(`Retrieved: ${meta.timestamp}  •  source: live headless browser on tradingview.com`);
  lines.push('');
  lines.push(
    pad('#', 3) +
      pad('SYM', 8) +
      pad('PRICE', 9) +
      pad('CHG', 8) +
      pad('CAP', 9) +
      pad('BETA', 6) +
      pad('5D%', 8) +
      pad('TREND LEGS', 22) +
      pad('SECTOR', 16) +
      'SCORE'
  );
  lines.push('-'.repeat(96));
  survivors.slice(0, cfg.topN).forEach((r, i) => {
    lines.push(
      pad(i + 1, 3) +
        pad(r.symbol, 8) +
        pad(fmtPrice(r.price), 9) +
        pad(fmtPct(r.changePct), 8) +
        pad(fmtCap(r.marketCap), 9) +
        pad(Number.isFinite(r.beta) ? r.beta.toFixed(2) : '—', 6) +
        pad(fmtPct(r.perfW), 8) +
        pad(trendTag(r), 22) +
        pad((r.sector || '—').slice(0, 15), 16) +
        r.score.toFixed(3)
    );
  });
  lines.push('');
  lines.push(
    'Legs: "52w-high" = at/near new 52-week high · "Nd-up" = N exact consecutive up-days ' +
      '(daily bars) · "wk-up~" = weekly+monthly up proxy (bars unavailable) · ' +
      '"anti-pump" = $500M-$1B, high-leg NOT trusted, cleared via up-days.'
  );
  lines.push(
    'MANUAL REVIEW (Step 4): confirm live prices before acting. Entry only on ' +
      'confirmed uptrend + catalyst — never a counter-trend bounce.'
  );
  lines.push('');
  return lines.join('\n');
}

export function renderRejectSummary(rejected) {
  const counts = {};
  for (const r of rejected)
    for (const reason of r.reasons) counts[reason] = (counts[reason] || 0) + 1;
  const lines = ['Rejections by reason:'];
  Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => lines.push(`  ${String(v).padStart(4)}  ${k}`));
  return lines.join('\n');
}
