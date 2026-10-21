#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
npm run verify
if [[ "${PI_DESKTOP_REAL_SMOKE:-0}" == "1" ]]; then
  npm run smoke
fi
