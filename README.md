# The Culprits — compilation map

One map carrying every dataset behind section (e) of the Destruction page, in
place of 55 separate embeds. Global view shows summed totals; zoom past the
threshold and individual assets load for the visible area only.

Runs entirely on free tiers.

## How it fits together

```
  release detection          normalize            tile              serve
  ─────────────────          ─────────            ────              ─────
  HEAD → ETag compare  →  shared 8-field  →  tippecanoe   →  .pmtiles in repo
  (weekly, Actions)          schema           clustered       or in R2 if >100MB
                                                                     │
  keyed live APIs  ────────────────────────────────────────────→  Worker
  (GFW, fishing, Land Matrix)                                    (holds keys)
                                                                     │
                                                              map/index.html
                                                            MapLibre + PMTiles
```

Two routes into the map, and it treats them the same.

**Pre-tiled.** Bulk sources and anything too large to query live are built into
PMTiles archives — a single-file format read by HTTP range request, so the
browser fetches only the tiles in view. No tile server. tippecanoe clusters
points below zoom 8 and sums their `value`, which is what makes the global view
a snapshot rather than a million markers.

Verified end to end with tippecanoe 2.68.0: Carbon Bombs builds to 1.0 MB
across zooms 0-12, and z0 rolls up to exactly 425 features and 1,182.3 Gt,
matching the source.

**Nothing is filtered and nothing is clustered.** Every feature a harvester
produces reaches the archive. tippecanoe thins only the densest points when a
single tile would exceed its size limit, and only in that tile — zooming in
restores full detail. The build prints what the world tile carries, e.g.
`12,200 of 34,936 features`, so the thinning is visible rather than assumed.

Clustering was tried and removed. It collapsed 34,936 power plants to one dot
at world view, and it fabricated attributes: a merged feature inherits one
arbitrary member's name and owner, so the global Carbon Bombs dot reported
1,182 Gt as a shelved Canadian coal mine. The cluster-aware popup path is kept
as a guard in case a future source needs clustering.

Filtering belongs to the reader, not the pipeline. Where a source covers more
than the map is about — WRI's database includes solar, hydro and wind — every
row is still harvested and the distinguishing field travels per feature.

**Live.** The three sources needing credentials go through a Cloudflare Worker
that holds the keys and adds the CORS headers the upstream APIs mostly omit.
The map sends a bounding box; the Worker caches at the edge so panning back over
somewhere already visited costs nothing.

## Why weekly, not continuous

These sources publish on release cycles — Forest 500 and Banking on Climate
Chaos are annual, GEM is versioned by release date. Polling hourly returns
identical bytes for months. The job HEADs each source, compares the ETag, and
skips anything unchanged, so a normal week does almost no work. What you get
isn't live so much as never stale, which is the most any of them can offer.

Global Energy Monitor is the one genuine exception: its download sits behind a
request form, so there is no URL to discover or poll. Drop each release into
`data/manual/gem/` and the pipeline picks it up from the file mtime. Worth
knowing that the Carbon Bombs dataset already carries GEM-derived coal and
oil & gas records, so some GEM coverage arrives without touching that form.

## Cost

| Service | Free allowance | What we use it for |
|---|---|---|
| GitHub Actions | unlimited on public repos | weekly harvest and tiling |
| GitHub Pages | free on public repos | map + archives under 100 MB |
| Cloudflare R2 | 10 GB storage, zero egress | archives over GitHub's 100 MB file cap |
| Cloudflare Workers | 100,000 requests/day | keyed API proxy |

Nothing here needs a card. The Workers ceiling is the only one worth watching:
each map pan past zoom 8 costs one request per live layer, and edge caching
absorbs the repeats.

## Licences

Carried per feature, not per file, so credit survives any merge. One matters
architecturally rather than cosmetically: **Land Matrix is CC BY-SA 4.0**, and
share-alike propagates into anything it's combined with. It's flagged
`isolate: true` in `sources.json` and gets its own archive; never merge it into
a file with another source.

Verified so far: EPA (public domain), Global Energy Monitor (CC BY 4.0), Land
Matrix (CC BY-SA 4.0), Global Fishing Watch (non-commercial only — fine while
the site stays non-commercial), Climate TRACE (free and publicly available).
Everything else is marked `licence_verified: false` and needs checking before
its harvester ships.

## Two geometries

Not every source has coordinates. Sources that do become points in a PMTiles
archive. Sources that only have country totals — Land Matrix is the first —
become a choropleth drawn against real national borders, keyed by ISO3.

They are never turned into centroids. A centroid looks exactly like a located
site and claims a precision the source never gave. `normalize.py` decides which
path a source takes from what the data actually contains, not from config.

Boundaries are built by `pipeline/build_boundaries.py`, which decimates the
14.6 MB source to 1.76 MB (0.30 MB gzipped) at roughly 11 km precision. Small
island states are exempted from the size filter so they don't vanish; 240 of
253 countries survive, and the microstates dropped are listed on every run.

## Units

Layers measure different things and are never combined into one figure. Each
feature carries its own `unit`, magnitude is encoded per layer, and the shared
circle symbol carries layer identity only. A shared size ramp across layers
would imply tonnes and hectares are comparable.

## Before publishing

Run through `_publish_blockers` in `sources.json`. It holds decisions that were
deliberately deferred so the build could proceed, and each one blocks going
public rather than blocking development. Currently one entry: Carbon Bombs has
no declared repo licence.

## No pinned URLs

No source stores a download path. Each module exposes `resolve()`, which finds
the current URL every run — the GitHub API for repo-hosted files, page scraping
for year-stamped ones. Banking on Climate Chaos stamps the year into its
filename; the harvester takes the highest year it finds, so a new annual
release is picked up the week it lands with nothing to re-check.

Where the API is rate-limited or down, `github_file()` falls back to the
conventional branch and the raw file's ETag, so the change signal degrades
rather than the harvest failing.

## Deploying

GitHub Pages serves `map/`. Everything the map fetches must therefore live
under `map/`:

    map/index.html          the page
    map/app.js              logic
    map/tiles/*.pmtiles     point layers, committed by refresh.yml
    map/data/*.json         country layers and boundaries

Pages branch deployment only offers `/` or `/docs` as a source folder, so it
cannot serve `map/` directly. `pages.yml` deploys it via Actions instead, which
can publish any directory.

    Settings → Pages → Source            : GitHub Actions
    Settings → Actions → Workflow perms  : read and write

The second is needed or `refresh.yml` cannot commit tiles. Tile commits touch
`map/`, so they trigger a redeploy automatically.

If you would rather avoid the extra workflow, the alternative is to rename
`map/` to `docs/`, set Pages to deploy from the branch `/docs` folder, and
update the two `map/` paths in `refresh.yml`. Then delete `pages.yml`.

The Worker deploys separately from `worker/`:

    wrangler deploy
    wrangler secret put GFW_API_KEY
    wrangler secret put GFW_FISHING_TOKEN

Then set `WORKER` in `map/app.js` to your workers.dev URL, and
`ALLOWED_ORIGINS` in `worker/index.js` to your Pages domain.

## Tests

    node worker/test.mjs        # Worker request handling, no network
    node map/test.mjs           # map wiring and popup honesty, no browser
    python pipeline/probe.py    # can every harvester still find its data?

Both run on every push via `.github/workflows/check.yml`. The Worker tests
found two bugs that would only have shown up in production: a non-numeric `z`
reaching the upstream as `zoom=NaN`, and cached responses being replayed to a
second allowed origin carrying the first origin's `Access-Control-Allow-Origin`,
which the browser would have rejected.

The map tests stub MapLibre strictly — the stub throws on the same things the
real library throws on — so `app.js` runs headless. They caught a `beforeId`
naming a layer that may not exist yet, which threw inside an async function and
so would have surfaced as an unhandled rejection with the layer silently
missing. They also pin the cluster popup: given a 425-site cluster carrying one
member's name, operator and link, the popup must state the count and withhold
all three.

The map logic lives in `map/app.js` rather than inline in the HTML, so it can
be run under test.

The Worker normalises every upstream into the atlas schema, so the map never
learns a source's private response shape. Those field mappings are inferred
rather than observed — when one is wrong the Worker returns a 502 naming
`shape()` rather than an empty layer, because "no data here" and "I could not
read the response" look identical on a map.

## Verifying a harvester

Not every source was reachable from the machine its harvester was written on.
Before trusting one, probe it:

    python pipeline/probe.py climate_trace --fetch

It resolves the URL, checks it responds, runs `fetch()`, and reports the row
count and a sample — writing nothing and touching no tiles. `sources.json`
marks which sources are `tested: true`; Carbon Bombs is, Climate TRACE is not.

## Adding a source

One file, one function:

```python
# pipeline/sources/carbon_bombs.py
def fetch():
    return [
        {"ident": "...", "name": "...", "lon": 0.0, "lat": 0.0,
         "value": 1234, "unit": "Gt CO2", "year": 2024, "url": "..."},
    ]
```

Add its entry to `sources.json`, set `ready: true` in `LAYERS` in
`map/index.html`, done. The driver imports it by id and skips it cleanly if it
doesn't exist yet, so the pipeline runs before all 20 are written.

## Status

Eight sources have verified access. Nine are unchecked, and five of those —
Allen Coral Atlas, Global Safety Net, Counterglow, Nusantara Atlas, PalmWatch —
are web applications that fetch their own data at runtime, so they may have
usable endpoints and belong in the live column rather than the bulk one. They're
flagged `check_runtime_endpoint` in `sources.json`.

Nothing under `pipeline/sources/` is written yet. That's deliberate: writing
harvesters against endpoints nobody has confirmed produces code that looks
finished and isn't.
