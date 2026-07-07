// The 4-step pipeline: filter -> trend -> size -> rank for 10x.
// Pure functions over the rows returned by tradingview.js.

// Count trailing consecutive up-days from a series of daily closes
// (oldest -> newest). An "up day" = close strictly greater than prior close.
export function consecutiveUpDays(closes) {
  if (!Array.isArray(closes) || closes.length < 2) return 0;
  let n = 0;
  for (let i = closes.length - 1; i > 0; i--) {
    if (closes[i].c > closes[i - 1].c) n++;
    else break;
  }
  return n;
}

// Is the latest close at/above a new 52-week high (within tolerance)?
export function atNewHigh(row, tolerance) {
  if (!row.high52w || !row.price) return false;
  return row.price >= row.high52w * (1 - tolerance);
}

// Attach trend facts to a row. Uses exact daily bars when present, otherwise
// falls back to scanner perf fields and flags the approximation.
export function assessTrend(row, cfg) {
  const nearHigh = atNewHigh(row, cfg.nearHighTolerance);

  let upDays = null;
  let upDaysSource = 'none';
  if (Array.isArray(row._dailyCloses) && row._dailyCloses.length >= 2) {
    upDays = consecutiveUpDays(row._dailyCloses);
    upDaysSource = 'daily-bars'; // exact
  } else {
    // Fallback proxy: rising over the week AND the month => a real uptrend leg,
    // just not a precise consecutive-day count. Flagged, never treated as exact.
    upDaysSource = 'perf-proxy';
  }

  const consecUpLeg =
    upDaysSource === 'daily-bars'
      ? upDays >= cfg.minConsecutiveUpDays
      : row.perfW > 0 && row.perf1M > 0; // proxy for the 5-day uptrend leg

  const inAntiPumpBand =
    row.marketCap >= cfg.antiPumpBandMin && row.marketCap < cfg.antiPumpBandMax;

  // Core trend rule (a): new 52w-high OR >=5 consecutive up days.
  // Anti-pump rule: in the $500M-$1B band a single-day spike prints its own
  // new high, so the high leg is NOT trusted there — require the up-day leg.
  const trendingUp = inAntiPumpBand ? consecUpLeg : nearHigh || consecUpLeg;

  return {
    ...row,
    nearHigh,
    upDays,
    upDaysSource,
    consecUpLeg,
    inAntiPumpBand,
    trendingUp,
  };
}

export function passesSize(row, cfg) {
  return row.marketCap >= cfg.marketCapMin && row.marketCap <= cfg.marketCapMax;
}

export function passesLiquidity(row, cfg) {
  const avgDollar = (row.avgVolume || 0) * (row.price || 0);
  return avgDollar >= cfg.minAvgDollarVolume;
}

// Step 3 — realistic 10x score. Skew toward US$500M-$10B with strong momentum.
// mode: 'balanced' | 'uptrend-first' | 'tenx-first'
export function tenXScore(row, cfg, mode = 'balanced') {
  const cap = row.marketCap || Infinity;

  // Size component: full weight in the sweet spot, decaying toward the ceiling.
  // 10x from a $30-50B base is near-impossible -> heavily penalized.
  let sizeScore;
  if (cap <= cfg.tenXSweetSpotMax) {
    // smaller within the sweet spot scores higher (more room to run)
    sizeScore = 1 - (cap - cfg.marketCapMin) / (cfg.tenXSweetSpotMax - cfg.marketCapMin);
    sizeScore = 0.6 + 0.4 * Math.max(0, Math.min(1, sizeScore)); // 0.6..1.0
  } else {
    const over = (cap - cfg.tenXSweetSpotMax) / (cfg.marketCapMax - cfg.tenXSweetSpotMax);
    sizeScore = 0.5 * (1 - Math.max(0, Math.min(1, over))); // 0.5..0
  }

  // Momentum / trend strength.
  const highLeg = row.nearHigh ? 1 : 0;
  const upLeg =
    row.upDaysSource === 'daily-bars'
      ? Math.min(1, (row.upDays || 0) / 10)
      : row.consecUpLeg
        ? 0.6
        : 0;
  const weekPerf = Math.max(0, Math.min(1, (row.perfW || 0) / 25)); // 0..1 by +25%/wk
  const momentum = 0.5 * upLeg + 0.3 * weekPerf + 0.2 * highLeg;

  // Volatility / high-beta preference (soft).
  const betaScore =
    row.beta && row.beta >= cfg.betaPreferred ? Math.min(1, row.beta / 3) : 0.2;

  // Today's pop magnitude (bounded).
  const popScore = Math.max(0, Math.min(1, (row.changePct || 0) / 30));

  let w;
  if (mode === 'uptrend-first') w = { size: 0.25, mom: 0.45, beta: 0.15, pop: 0.15 };
  else if (mode === 'tenx-first') w = { size: 0.5, mom: 0.25, beta: 0.15, pop: 0.1 };
  else w = { size: 0.4, mom: 0.35, beta: 0.15, pop: 0.1 };

  const score =
    w.size * sizeScore + w.mom * momentum + w.beta * betaScore + w.pop * popScore;

  return { score, sizeScore, momentum, betaScore, popScore };
}

// Run the whole pipeline over enriched rows. Returns { survivors, rejected }.
export function runPipeline(rows, cfg, mode = 'balanced') {
  const rejected = [];
  const survivors = [];

  for (const raw of rows) {
    const row = assessTrend(raw, cfg);
    const reasons = [];

    if (!passesSize(row, cfg)) reasons.push('cap out of $500M-$50B band');
    if (!row.trendingUp)
      reasons.push(
        row.inAntiPumpBand
          ? 'anti-pump band: no 5-day up-leg'
          : 'not at 52w high and no up-leg (counter-trend)'
      );
    if (!passesLiquidity(row, cfg)) reasons.push('avg $-volume too thin for +50% exit');

    if (reasons.length) {
      rejected.push({ ...row, reasons });
      continue;
    }

    const scoreParts = tenXScore(row, cfg, mode);
    survivors.push({ ...row, ...scoreParts });
  }

  survivors.sort((a, b) => b.score - a.score);
  return { survivors, rejected };
}
