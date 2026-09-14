#!/usr/bin/env bash
# Turn normalized line-delimited GeoJSON into one .pmtiles archive per source.
#
# The zoom behaviour is done here, in the tiling, not in the map's JavaScript.
# Below zoom 8 tippecanoe clusters points into aggregate features and sums their
# `value`, so the global view is a snapshot of shape and magnitude rather than
# a million markers. From zoom 8 up, clustering stops and individual features
# appear, and the browser range-requests only the tiles it can see.
#
# Usage: build_tiles.sh <source_id> <normalized.geojsonl> [out_dir]
#
# Default out_dir is map/tiles — GitHub Pages serves map/, and the map fetches
# ./tiles/<id>.pmtiles relative to itself.

set -euo pipefail

SOURCE="${1:?source id required}"
INPUT="${2:?input geojsonl required}"
OUTDIR="${3:-map/tiles}"

mkdir -p "$OUTDIR"
OUT="$OUTDIR/${SOURCE}.pmtiles"

# --cluster-maxzoom is the threshold the map's legend refers to. Changing it
# here changes where the map stops summarising and starts listing, so keep it
# in step with CLUSTER_MAXZOOM in map/index.html.
MAXZOOM=12

# No clustering, and no feature filtering. Every feature the harvester produced
# goes in. tippecanoe thins only the densest points when a single tile would
# exceed its size limit, and only in that tile — nothing is removed from the
# dataset, and zooming in restores full detail.
#
# The alternative, clustering, was worse on both counts: it collapsed 34,936
# plants to one dot at world view, and it fabricated attributes, since a merged
# feature inherits one arbitrary member's name and owner.
# The input may be gzipped: at 99 million features the plain file is tens of
# gigabytes. tippecanoe reads gzipped GeoJSON directly, so only the line count
# needs to know the difference.
case "$INPUT" in
  *.gz) FEATURES=$(gzip -cd "$INPUT" | wc -l) ;;
  *)    FEATURES=$(wc -l < "$INPUT") ;;
esac

# Attribution is baked into the archive so credit travels with the data even if
# the file is copied somewhere else.
ATTRIBUTION=$(python3 -c "
import json,sys
reg=json.load(open('sources.json'))
s={x['id']:x for x in reg['sources']}.get('$SOURCE',{})
print(f\"{s.get('name','$SOURCE')} — {s.get('licence','licence unchecked')}\")
")

# tippecanoe needs scratch space that scales with FEATURE COUNT, not input
# size: 112 million features wanted ~10 GB while the gzipped input was 1.6 GB.
# It does NOT honour TMPDIR — setting that and watching it fill the internal
# disk anyway is how this was found. TILE_TMPDIR points it somewhere with room,
# e.g. an external drive:
#
#   TILE_TMPDIR="/Volumes/MY DRIVE/tc-tmp" ./pipeline/build_tiles.sh ...
#
# Unset, tippecanoe uses its own default and small sources are unaffected.
TMPFLAG=()
if [ -n "${TILE_TMPDIR:-}" ]; then
  mkdir -p "$TILE_TMPDIR"
  TMPFLAG=(--temporary-directory="$TILE_TMPDIR")
  echo "$SOURCE: tiling scratch in $TILE_TMPDIR"
fi

tippecanoe \
  "${TMPFLAG[@]}" \
  --quiet \
  --output="$OUT" \
  --force \
  --layer="$SOURCE" \
  --name="$SOURCE" \
  --minimum-zoom=0 \
  --maximum-zoom="$MAXZOOM" \
  --drop-rate=1 \
  --drop-densest-as-needed \
  --preserve-input-order \
  --attribution="$ATTRIBUTION" \
  "$INPUT"

SIZE=$(stat -c%s "$OUT" 2>/dev/null || stat -f%z "$OUT")
echo "$SOURCE: $(( SIZE / 1024 / 1024 )) MB -> $OUT"

# Archive size is not what the reader pays. PMTiles fetches tiles by range
# request, so the number that matters is the heaviest tile someone actually
# loads — the world tile, which every visitor gets. Report it, because a large
# archive with small tiles is fine and a small archive with a 5 MB z0 tile is
# not.
FEATURE_COUNT="$FEATURES" python3 - "$OUT" "$SOURCE" <<'TILECHECK' || true
import sys, os
path, layer = sys.argv[1], sys.argv[2]

# Every import here is optional. This block reports on the archive; it does not
# make it. A missing library must not fail a build that already succeeded.
try:
    import gzip
    from pmtiles.reader import Reader, MmapSource
    import mapbox_vector_tile as mvt
except ImportError as e:
    print(f"{layer}: skipping world-tile report ({e})")
    raise SystemExit(0)

try:
    r = Reader(MmapSource(open(path, "rb")))
    z0 = r.get(0, 0, 0)
    if not z0:
        print(f"::error::{layer} has no world tile — the map will look empty at "
              f"the default zoom")
        raise SystemExit(0)
    kb = len(z0) / 1000
    raw = gzip.decompress(z0) if z0[:2] == b"\x1f\x8b" else z0
    shown = len(mvt.decode(raw).get(layer, {}).get("features", []))
    total = int(os.environ.get("FEATURE_COUNT", 0))
    frac = f" of {total:,}" if total else ""
    print(f"{layer}: world tile {kb:.0f} KB carrying {shown:,}{frac} features "
          f"— every visitor downloads this")
    if kb > 800:
        print(f"::warning::{layer} world tile is {kb:.0f} KB")
except Exception as e:
    print(f"{layer}: could not inspect archive ({e})")
TILECHECK

# GitHub refuses files over 100 MB. Anything larger belongs in R2, which serves
# range requests the same way and costs nothing to read.
if [ "$SIZE" -gt 99000000 ]; then
  echo "::warning::${SOURCE}.pmtiles exceeds GitHub's 100 MB file limit — upload to R2 instead"
  echo "$SOURCE" >> "$OUTDIR/.needs-r2"
fi
