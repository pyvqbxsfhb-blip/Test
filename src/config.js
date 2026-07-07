// Default thresholds for the gainers pipeline.
// Every value is overridable via CLI flags (see scan.js).

export const DEFAULTS = {
  // --- Step 1: universe ---
  markets: ['america'],
  exchanges: ['NASDAQ', 'NYSE', 'AMEX'],
  // How many raw gainers to pull from TradingView before filtering.
  scanSize: 300,
  // Minimum single-day % change to even be considered a "gainer".
  minChangePct: 3,

  // --- Step 2b: size band (hard rule) ---
  marketCapMin: 500e6, // US$500M absolute floor (screens sub-$500M pump/halt traps)
  marketCapMax: 50e9, // US$50B ceiling

  // --- Step 2a: trend leg ---
  // "at a new 52-week high" => close within this fraction of the 52w high.
  nearHighTolerance: 0.005, // 0.5%
  // consecutive up-day requirement for the "5-day uptrend" leg.
  minConsecutiveUpDays: 5,
  // Anti-pump band: for caps in [antiPumpBandMin, antiPumpBandMax] a single-day
  // spike makes a new high on its own spike day, so the 52wk-high leg is NOT
  // trusted — these names MUST clear the consecutive-up-days leg instead.
  antiPumpBandMin: 500e6,
  antiPumpBandMax: 1e9,

  // --- Rules / preferences ---
  betaPreferred: 1.5, // high-beta preferred (soft signal, not a hard cut)
  // Liquidity: average daily $ volume must comfortably absorb a +50% exit.
  // We require avg daily dollar-volume >= this floor.
  minAvgDollarVolume: 5e6,

  // --- Step 3: 10x skew ---
  // Names below this cap get the strongest 10x weighting.
  tenXSweetSpotMax: 10e9,

  // --- Freshness discipline ---
  // Per-ticker daily-bar enrichment (exact consecutive up days + 52wk-high
  // verification). Best-effort: falls back to scanner perf fields if it fails.
  enrichDailyBars: true,
  // Cap how many survivors we deep-verify with daily bars (keeps runs fast).
  maxEnrich: 40,

  // --- Output ---
  topN: 25,
};

// Which "trend-first vs 10x-first" bias to apply when ranking (Step 3 / the
// structural tension the user called out). 'balanced' blends both.
export const RANK_MODES = ['balanced', 'uptrend-first', 'tenx-first'];
