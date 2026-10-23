#!/usr/bin/env bash
# Assemble dist/: the landing page at the root, the app under /app/.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf dist
npm --prefix ../landing run build
(cd ../app && VITE_BASE=/app/ npx vite build --outDir ../web/dist/app --emptyOutDir)
cp -r ../landing/dist/. dist/
echo "dist/: landing at /, app at /app/"
