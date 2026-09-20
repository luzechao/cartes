#!/usr/bin/env bash
# Download the EnergyPlus IDD archive for every version the editor targets (7.2 -> current).
# IDDs are ~4.5 MB each and are build inputs, not source: they land in the gitignored
# idd-cache/ and are consumed by scripts/preprocess-idd.ts.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p idd-cache
BASE="https://raw.githubusercontent.com/NREL/EnergyPlus/develop/idd/versions"

VERSIONS="7-2-0 8-0-0 8-1-0 8-2-0 8-3-0 8-4-0 8-5-0 8-6-0 8-7-0 8-8-0 8-9-0 \
9-0-0 9-1-0 9-2-0 9-3-0 9-4-0 9-5-0 9-6-0 \
22-1-0 22-2-0 23-1-0 23-2-0 24-1-0 24-2-0 25-1-0 25-2-0 26-1-0"

for v in $VERSIONS; do
  out="idd-cache/V${v}.idd"
  if [ -s "$out" ]; then continue; fi
  echo "fetching $v"
  curl -fsSL -o "$out" "${BASE}/V${v}-Energy%2B.idd" || { echo "FAILED $v" >&2; rm -f "$out"; }
done
echo "have $(ls idd-cache/*.idd | wc -l | tr -d ' ') IDD files"
