#!/usr/bin/env node
import { DEFAULTS, RANK_MODES } from './config.js';
import {
  launchBrowser,
  openSite,
  scanGainers,
  getDailyBars,
} from './tradingview.js';
import { runPipeline, assessTrend, passesSize } from './pipeline.js';
import { renderTable, renderRejectSummary } from './format.js';

function parseArgs(argv) {
  const cfg = { ...DEFAULTS };
  const flags = { json: false, mode: 'balanced', showRejects: false, noEnrich: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--json': flags.json = true; break;
      case '--rejects': flags.showRejects = true; break;
      case '--no-enrich': cfg.enrichDailyBars = false; break;
      case '--mode': flags.mode = next(); break;
      case '--min-change': cfg.minChangePct = Number(next()); break;
      case '--cap-min': cfg.marketCapMin = Number(next()); break;
      case '--cap-max': cfg.marketCapMax = Number(next()); break;
      case '--scan-size': cfg.scanSize = Number(next()); break;
      case '--top': cfg.topN = Number(next()); break;
      case '--max-enrich': cfg.maxEnrich = Number(next()); break;
      case '--help': case '-h': flags.help = true; break;
      default:
        console.error(`Unknown flag: ${a}`);
        flags.help = true;
    }
  }
  if (!RANK_MODES.includes(flags.mode)) {
    console.error(`--mode must be one of: ${RANK_MODES.join(', ')}`);
    flags.help = true;
  }
  return { cfg, flags };
}

function help() {
  console.log(`
tv-scan — live TradingView top-gainers scanner (headless browser, no static HTML)

Pipeline: (1) pull live US gainers  (2) trend + $500M-$50B size  (3) rank 10x  (4) shortlist

Usage: node src/scan.js [options]

  --mode <m>        ranking bias: balanced | uptrend-first | tenx-first  (default balanced)
  --min-change <n>  min single-day %% gain to consider          (default ${DEFAULTS.minChangePct})
  --cap-min <n>     market-cap floor in USD                     (default ${DEFAULTS.marketCapMin})
  --cap-max <n>     market-cap ceiling in USD                   (default ${DEFAULTS.marketCapMax})
  --scan-size <n>   raw gainers to pull before filtering        (default ${DEFAULTS.scanSize})
  --max-enrich <n>  max survivors to verify with daily bars     (default ${DEFAULTS.maxEnrich})
  --top <n>         rows to print                               (default ${DEFAULTS.topN})
  --no-enrich       skip exact daily-bar verification (faster, uses perf proxy)
  --rejects         print a summary of why names were dropped
  --json            emit machine-readable JSON instead of a table
`);
}

async function main() {
  const { cfg, flags } = parseArgs(process.argv);
  if (flags.help) return help();

  const log = flags.json ? () => {} : (...a) => console.error(...a);
  const timestamp = new Date().toISOString();

  log('▶ launching headless Chromium …');
  const browser = await launchBrowser();
  let payload;
  try {
    log('▶ loading tradingview.com (establishing live session) …');
    const page = await openSite(browser);

    log('▶ Step 1: pulling live top gainers from TradingView scanner …');
    const { totalCount, rows } = await scanGainers(page, cfg);
    log(`  ↳ ${rows.length} raw gainers (of ${totalCount} matching change > ${cfg.minChangePct}%)`);

    // Pre-filter to the size band BEFORE the expensive daily-bar enrichment so
    // we only deep-verify plausibly-tradeable names.
    const sized = rows.filter((r) => passesSize(assessTrend(r, cfg), cfg));
    log(`  ↳ ${sized.length} within $${cfg.marketCapMin / 1e6}M-$${cfg.marketCapMax / 1e9}B cap band`);

    // Step 2a freshness discipline: exact consecutive up-days via daily bars.
    if (cfg.enrichDailyBars && sized.length) {
      const toEnrich = sized.slice(0, cfg.maxEnrich);
      log(`▶ verifying ${toEnrich.length} names with live daily bars (exact up-day counts) …`);
      let ok = 0;
      for (const r of toEnrich) {
        const closes = await getDailyBars(page, r.fullSymbol, 40);
        if (closes && closes.length) {
          r._dailyCloses = closes;
          ok++;
        }
      }
      log(`  ↳ daily bars captured for ${ok}/${toEnrich.length} (rest fall back to perf proxy)`);
      if (sized.length > cfg.maxEnrich)
        log(`  ⚠ ${sized.length - cfg.maxEnrich} names beyond --max-enrich use the perf proxy`);
    }

    const { survivors, rejected } = runPipeline(sized, cfg, flags.mode);
    payload = { timestamp, mode: flags.mode, scanned: rows.length, survivors, rejected };
  } finally {
    await browser.close();
  }

  if (flags.json) {
    const slim = payload.survivors.map((r) => ({
      symbol: r.symbol,
      name: r.name,
      exchange: r.exchange,
      price: r.price,
      changePct: r.changePct,
      marketCap: r.marketCap,
      sector: r.sector,
      beta: r.beta,
      perfW: r.perfW,
      high52w: r.high52w,
      nearHigh: r.nearHigh,
      upDays: r.upDays,
      upDaysSource: r.upDaysSource,
      trendingUp: r.trendingUp,
      inAntiPumpBand: r.inAntiPumpBand,
      score: r.score,
    }));
    console.log(
      JSON.stringify(
        { timestamp: payload.timestamp, mode: payload.mode, scanned: payload.scanned, survivors: slim },
        null,
        2
      )
    );
    return;
  }

  console.log(renderTable(payload.survivors, cfg, payload));
  if (flags.showRejects) console.log(renderRejectSummary(payload.rejected) + '\n');
}

main().catch((e) => {
  console.error('✖ scan failed:', e.message);
  process.exit(1);
});
