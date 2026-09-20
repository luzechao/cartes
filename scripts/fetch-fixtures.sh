#!/usr/bin/env bash
# Fetch a small, geometry-rich IDF sample from several EnergyPlus releases.
#
# The bulk corpus in test/fixtures/testfiles/ is all one version (develop), so it cannot
# catch a version-keyed field-index regression. These per-version samples can: they span
# the 9.5 -> 9.6 boundary where `Space Name` was inserted into BuildingSurface:Detailed
# and shifted every field after it.
#
# testfiles/ only exists at the repo root from v8.3.0 onward; earlier releases used a
# different layout and are covered by the IDD archive alone.
set -uo pipefail
cd "$(dirname "$0")/.."

BASE="https://raw.githubusercontent.com/NREL/EnergyPlus"
TAGS="v8.3.0 v8.5.0 v8.7.0 v8.9.0 v9.3.0 v9.6.0 v22.2.0 v24.2.0"

# Long-lived files chosen for geometry coverage: detailed surfaces, shading,
# fenestration, relative vs world coordinates. Misses are tolerated — the set of
# testfiles shifts between releases.
FILES="1ZoneUncontrolled.idf
4ZoneWithShading_Simple_1.idf
5ZoneAirCooled.idf
RefBldgSmallOfficeNew2004_Chicago.idf
DaylightingDeviceShelf.idf
PurchAirWithDaylighting.idf
SurfaceZoneAdjacency.idf
WindowTests.idf"

total=0
for tag in $TAGS; do
  ver="${tag#v}"
  dir="test/fixtures/versions/${ver}"
  mkdir -p "$dir"
  got=0
  for f in $FILES; do
    out="${dir}/${f}"
    [ -s "$out" ] && { got=$((got + 1)); continue; }
    if curl -fsSL -o "$out" "${BASE}/${tag}/testfiles/${f}" 2>/dev/null; then
      got=$((got + 1))
    else
      rm -f "$out"
    fi
  done
  total=$((total + got))
  echo "  ${ver}: ${got} files"
done
echo "fetched ${total} version-tagged fixtures"
