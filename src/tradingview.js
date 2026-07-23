import { chromium } from 'playwright';

const CHROMIUM_PATH = '/opt/pw-browsers/chromium';
const SCANNER_ENDPOINT = 'https://scanner.tradingview.com/america/scan';
const SITE_ORIGIN = 'https://www.tradingview.com';

// Scanner columns we request, in order. `d[]` in the response maps 1:1 to this.
export const COLUMNS = [
  'name', // ticker symbol, e.g. "XYZ"
  'description', // company name
  'close', // last price
  'change', // % change today
  'change_abs', // absolute change today
  'volume', // today's volume
  'relative_volume_10d_calc',
  'average_volume_10d_calc',
  'market_cap_basic',
  'sector',
  'exchange',
  'price_52_week_high',
  'price_52_week_low',
  'High.All',
  'Perf.W', // ~1 trading week (5d) % change
  'Perf.1M',
  'Perf.3M',
  'beta_1_year',
  // --- orthogonal (non-candle) metrics for sustainability scoring ---
  'Perf.6M',
  'Perf.Y',
  'ADX', // trend strength (Wilder); >25 strong, >40 very strong
  'Recommend.All', // TradingView aggregate technical rating, -1..+1
  'SMA50',
  'SMA200',
  'float_shares_percent_current',
  'Volatility.D',
  'Value.Traded', // today's traded dollar value (impact/magnitude)
  'gap', // opening gap % (FOMO chase signal)
];

function rowToObj(item) {
  const d = item.d || [];
  const o = {};
  COLUMNS.forEach((c, i) => (o[c] = d[i]));
  return {
    fullSymbol: item.s, // "NASDAQ:XYZ"
    symbol: o['name'],
    name: o['description'],
    price: o['close'],
    changePct: o['change'],
    changeAbs: o['change_abs'],
    volume: o['volume'],
    relVolume: o['relative_volume_10d_calc'],
    avgVolume: o['average_volume_10d_calc'],
    marketCap: o['market_cap_basic'],
    sector: o['sector'],
    exchange: o['exchange'],
    high52w: o['price_52_week_high'],
    low52w: o['price_52_week_low'],
    highAll: o['High.All'],
    perfW: o['Perf.W'],
    perf1M: o['Perf.1M'],
    perf3M: o['Perf.3M'],
    beta: o['beta_1_year'],
    perf6M: o['Perf.6M'],
    perfY: o['Perf.Y'],
    adx: o['ADX'],
    techRating: o['Recommend.All'],
    sma50: o['SMA50'],
    sma200: o['SMA200'],
    floatPct: o['float_shares_percent_current'],
    volatilityD: o['Volatility.D'],
    valueTraded: o['Value.Traded'],
    gap: o['gap'],
  };
}

export async function launchBrowser() {
  // Route the browser's traffic through the environment's egress proxy so it
  // reaches tradingview.com; TLS is re-terminated there against the CA bundle
  // that the system/NSS trust store is already primed with.
  const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy;
  return chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    proxy: proxyServer ? { server: proxyServer } : undefined,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      // The egress proxy re-terminates TLS but does not implement TLS 1.3
      // Encrypted Client Hello; Chromium's ECH handshake gets reset. Pinning
      // TLS 1.2 makes the MITM handshake succeed cleanly against the trusted
      // CA. (Only applied when routing through the proxy.)
      ...(proxyServer ? ['--ssl-version-max=tls1.2'] : []),
      '--disable-features=EncryptedClientHello,UseDnsHttpsSvcb,UseDnsHttpsSvcbAlpn',
      '--dns-over-https-mode=off',
    ],
  });
}

// Establish a real tradingview.com browsing context so subsequent in-page
// fetches carry the site's origin / cookies (not a bare static request).
export async function openSite(browser) {
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
  });
  const page = await context.newPage();
  await page.goto(`${SITE_ORIGIN}/screener/`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  // Let the SPA settle so its cookies/token are in place.
  await page.waitForTimeout(1500);
  return page;
}

/**
 * Step 1 — pull the current top gainers straight from TradingView's live
 * scanner, executed from inside the loaded tradingview.com page (JS context,
 * not a static HTML scrape). Returns rows sorted by today's % change desc.
 */
export async function scanGainers(page, opts) {
  const { exchanges, scanSize, minChangePct } = opts;

  const payload = {
    columns: COLUMNS,
    filter: [
      { left: 'type', operation: 'in_range', right: ['stock', 'dr'] },
      { left: 'exchange', operation: 'in_range', right: exchanges },
      { left: 'change', operation: 'greater', right: minChangePct },
      { left: 'is_primary', operation: 'equal', right: true },
    ],
    ignore_unknown_fields: false,
    options: { lang: 'en' },
    range: [0, scanSize],
    sort: { sortBy: 'change', sortOrder: 'desc' },
    symbols: {},
    markets: ['america'],
  };

  const result = await page.evaluate(
    async ({ endpoint, body }) => {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify(body),
        credentials: 'include',
      });
      if (!res.ok) {
        return { error: `HTTP ${res.status}`, text: await res.text() };
      }
      return await res.json();
    },
    { endpoint: SCANNER_ENDPOINT, body: payload }
  );

  if (result.error) {
    throw new Error(
      `TradingView scanner request failed: ${result.error} ${result.text || ''}`
    );
  }
  const rows = (result.data || []).map(rowToObj);
  return { totalCount: result.totalCount ?? rows.length, rows };
}

/**
 * Best-effort exact daily bars for a symbol, spoken over TradingView's own
 * data websocket from inside the page (so it uses the site's session). Returns
 * an array of daily closes (oldest -> newest) or null on any failure/timeout.
 * Used to compute EXACT consecutive up-days and verify the 52-week high leg.
 */
export async function getDailyBars(page, fullSymbol, count = 40, timeoutMs = 12000) {
  try {
    const bars = await page.evaluate(
      ({ sym, n, tmo }) =>
        new Promise((resolve) => {
          const done = (v) => {
            try {
              ws && ws.close();
            } catch {}
            resolve(v);
          };
          const timer = setTimeout(() => done(null), tmo);

          const rand = () =>
            'xxxxxxxxxxxx'.replace(/x/g, () =>
              // deterministic-ish per call is fine; TV only needs uniqueness
              ((Math.floor(performance.now() * 1000) + Math.random() * 1e6) % 36 | 0).toString(36)
            );
          const csSession = 'cs_' + rand();
          const seriesId = 's1';

          const frame = (name, params) => {
            const msg = JSON.stringify({ m: name, p: params });
            return `~m~${msg.length}~m~${msg}`;
          };

          let ws;
          try {
            ws = new WebSocket(
              'wss://data.tradingview.com/socket.io/websocket?from=screener&type=chart'
            );
          } catch (e) {
            clearTimeout(timer);
            return done(null);
          }

          const send = (name, params) => ws.send(frame(name, params));

          ws.onopen = () => {
            send('set_auth_token', ['unauthorized_user_token']);
            send('chart_create_session', [csSession, '']);
            send('resolve_symbol', [
              csSession,
              'sds_sym_1',
              `={"symbol":"${sym}","adjustment":"splits"}`,
            ]);
            send('create_series', [
              csSession,
              seriesId,
              's1',
              'sds_sym_1',
              '1D',
              n,
              '',
            ]);
          };

          let ohlc = null;
          ws.onmessage = (ev) => {
            const data = ev.data;
            // Reply to heartbeats: frames like ~m~N~m~~h~M
            const hb = data.match(/~m~\d+~m~(~h~\d+)/);
            if (hb) {
              ws.send(`~m~${hb[1].length}~m~${hb[1]}`);
              return;
            }
            // Split multiplexed frames and pull JSON payloads.
            const parts = data.split(/~m~\d+~m~/).filter(Boolean);
            for (const p of parts) {
              if (!p.startsWith('{')) continue;
              let obj;
              try {
                obj = JSON.parse(p);
              } catch {
                continue;
              }
              if (obj.m === 'timescale_update' && obj.p && obj.p[1]) {
                const series = obj.p[1][seriesId] || obj.p[1]['s1'];
                const s = series && series.s;
                if (Array.isArray(s) && s.length) {
                  // each entry: { i, v:[time, open, high, low, close, volume] }
                  ohlc = s
                    .map((x) => ({
                      t: x.v[0],
                      o: x.v[1],
                      h: x.v[2],
                      l: x.v[3],
                      c: x.v[4],
                      v: x.v[5],
                    }))
                    .filter((b) => Number.isFinite(b.c))
                    .sort((a, b) => a.t - b.t);
                }
              }
              if (obj.m === 'series_completed' || obj.m === 'symbol_error') {
                clearTimeout(timer);
                return done(ohlc && ohlc.length ? ohlc : null);
              }
            }
          };
          ws.onerror = () => {
            clearTimeout(timer);
            done(null);
          };
        }),
      { sym: fullSymbol, n: count, tmo: timeoutMs }
    );
    return bars;
  } catch {
    return null;
  }
}
