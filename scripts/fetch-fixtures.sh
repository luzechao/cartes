#!/usr/bin/env bash
# Fetch the fixture corpora. Both are downloaded, not committed.
#
# 1. test/fixtures/testfiles/ — 126 files from EnergyPlus's develop branch, pinned to one commit
#    and verified against test/fixtures/testfiles.manifest, so every checkout tests the same bytes.
#    Many tests assert exact counts over this corpus; a drifting corpus would break them silently.
#
# 2. test/fixtures/versions/ — a small, geometry-rich IDF sample from several EnergyPlus releases.
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

# --- 1. the pinned develop corpus -------------------------------------------------------------
CORPUS_COMMIT="c36cbdde45741a258bfaca0b26ab3c0fe2af2568"
MANIFEST="test/fixtures/testfiles.manifest"
mkdir -p test/fixtures/testfiles

grep -v '^#' "$MANIFEST" | while read -r sha name; do
  out="test/fixtures/testfiles/${name}"
  [ -s "$out" ] && [ "$(git hash-object "$out")" = "$sha" ] && continue
  echo "${name}"
done | URL_BASE="${BASE}/${CORPUS_COMMIT}/testfiles" xargs -P 8 -n 1 sh -c \
  'curl -fsSL -o "test/fixtures/testfiles/$1" "$URL_BASE/$1" || echo "FAILED $1" >&2' _

bad=0
while read -r sha name; do
  out="test/fixtures/testfiles/${name}"
  if [ ! -s "$out" ] || [ "$(git hash-object "$out")" != "$sha" ]; then
    echo "MISMATCH ${name}" >&2
    bad=$((bad + 1))
  fi
done < <(grep -v '^#' "$MANIFEST")
if [ "$bad" -gt 0 ]; then
  echo "${bad} corpus file(s) missing or not the pinned bytes" >&2
  exit 1
fi
echo "corpus: $(grep -vc '^#' "$MANIFEST") files, verified against ${MANIFEST}"

# --- 2. per-release samples ---------------------------------------------------------------------
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
