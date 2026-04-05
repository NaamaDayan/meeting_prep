#!/usr/bin/env bash
# Build a deployment zip for AWS Lambda (Node.js). Excludes server/.env.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/server"
npm install --omit=dev
OUT="$ROOT/meeting_prep_prototype-lambda.zip"
rm -f "$OUT"
zip -qr "$OUT" . -x ".env" -x ".env.*" -x "*.zip" -x ".DS_Store" -x ".enrichment-cache.json"
echo "Wrote $OUT (set Lambda handler to lambda.handler)"
