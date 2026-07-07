#!/usr/bin/env bash
# One-time setup for the TradingView gainers scanner.
# Prefers the globally-installed Playwright (already bundled with a Chromium in
# this environment) and symlinks it in, avoiding any re-download. Falls back to
# a normal `npm install` if no global copy is found.
set -euo pipefail
cd "$(dirname "$0")"

GLOBAL_ROOT="$(npm root -g 2>/dev/null || echo /opt/node22/lib/node_modules)"

if [ -d "$GLOBAL_ROOT/playwright" ]; then
  echo "Using global Playwright at $GLOBAL_ROOT/playwright"
  mkdir -p node_modules
  ln -sfn "$GLOBAL_ROOT/playwright" node_modules/playwright
  [ -d "$GLOBAL_ROOT/playwright-core" ] && ln -sfn "$GLOBAL_ROOT/playwright-core" node_modules/playwright-core
else
  echo "Global Playwright not found; installing locally (skipping browser download)"
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
fi

node -e "require('playwright'); console.log('Playwright resolves OK')"
echo "Setup complete. Run: node src/scan.js --help"
