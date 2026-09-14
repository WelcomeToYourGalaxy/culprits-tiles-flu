# Culprits atlas — handoff

Paste this into a new chat. Attach the repo zip, or just the files the issue
touches.

---

## What this is

`WelcomeToYourGalaxy/culprits` — a MapLibre map merging datasets on who is
driving environmental destruction. It replaces 55 third-party iframes that were
embedded in section (e) of my Destruction page.

Live at `welcometoyourgalaxy.github.io/culprits`.

Non-commercial civic education. Everything runs on free tiers: GitHub Actions +
Pages, Cloudflare Workers.

---

## My setup, so you know what I am typing into

macOS 12.6, Intel. zsh. **zsh does not treat `#` as a comment in an interactive
shell** — do not put trailing `# explanatory comments` on commands you give me,
they get read as filenames and produce confusing errors.

Two folders on the Desktop:

    ~/Desktop/culprits          the git clone — work here, this is what pushes
    ~/Desktop/culprits-local    the older unzipped-download folder, kept as backup

`culprits` was cloned fresh partway through the last session, because the
original folder was an unzipped download with no `.git` and nothing could be
pushed from it. If `git status` says "not a git repository", I am in the wrong
folder.

Python work needs the venv, which lives in the clone:

    cd ~/Desktop/culprits
    source .venv/bin/activate
    # if that fails:
    #   python3 -m venv .venv && source .venv/bin/activate
    #   pip install requests openpyxl

Node came from nodejs.org, not Homebrew — `brew install node` started building
LLVM from source and would have taken hours. Python is 3.9 locally, 3.12 in CI.

**Big files live on an external drive.** `data/` is a symlink:

    data -> /Volumes/<DRIVE>/culprits-data

and harvests need a temp dir there too, because each Climate TRACE sector zip is
up to 1.4 GB and would otherwise land on the system disk:

    export TMPDIR=/Volumes/<DRIVE>/culprits-tmp

That is per-terminal — set it before every harvest, or put it in `~/.zshrc`. The
repo itself stays on the Desktop; only `data/` was moved.

**`.venv/` is currently inside the repo and not gitignored.** Hundreds of MB.
Add `.venv/`, `.DS_Store` and `worker/.wrangler/` to `.gitignore` before the
next commit — `wrangler-account.json` is local Cloudflare state and this is a
public repo.

**Watch out when I download files from chat.** Both test files are named
`test.mjs`, and three times last session a download landed on the wrong one —
map tests ended up in `worker/` and vice versa. Symptom is `Cannot find module
.../map/index.js` or `.../worker/app.js`. Verify with `head -2 worker/test.mjs`
("Worker tests") and `head -2 map/test.mjs` ("Map logic tests"). Give me files
one at a time.

---

## Two separate deploys, easy to confuse

- `map/` is served from **GitHub Pages** — `git push` publishes it.
- `worker/` runs on **Cloudflare** — `cd worker && npx wrangler deploy`.

Pushing does not deploy the Worker. Deploying does not update the map. Several
"fixes that didn't work" were one without the other.

Worker: `https://culprits-proxy.welcometoyourgalaxy.workers.dev`

---

## How data reaches the map — five routes

Set per layer in `map/app.js` as `route:`.

**`pmtiles`** — a Python harvester pulls a source, `normalize.py` maps it to a
shared 8-field schema, tippecanoe tiles it into `map/tiles/<id>.pmtiles`.
Actions refreshes weekly. For located things: plants, mines, facilities.

**`country`** — a country-level choropleth from a small JSON in `map/data/`.

**`worker`** — the Worker proxies a keyed or CORS-less API per viewport and
returns GeoJSON in the shared schema. For live queries where a key cannot sit
in page source.

**`tile`** — the Worker proxies an upstream's own tile endpoint per z/x/y and
passes the bytes through. For a continuous field rather than located things,
and for upstreams whose per-request endpoint is quota'd beyond what a public
page can satisfy.

**`wmts`** — the map fetches raster tiles straight from the publisher, no
Worker. Only where there is no key to hide and the host sends CORS.

---

## Layers, and the state of each

**Working**

| Layer | Source | Route |
|---|---|---|
| National CO₂ emissions | Our World in Data | country |
| Land deals | Land Matrix | country |
| Carbon bombs | Data For Good / carbonbombs.org | pmtiles |
| US toxic release sites | EPA Envirofacts TRI | worker |
| Permitted animal feeding operations (US) | EPA Envirofacts CAFO | worker |
| Fishing effort | Global Fishing Watch 4Wings | tile |
| Deforestation alerts — tropics | GFW integrated (GLAD + RADD) | tile |
| Disturbance alerts — global, 30 day | GFW DIST-ALERT | tile |
| Disturbance alerts — global, 365 day | GFW DIST-ALERT | tile |
| Livestock density × 6 species | FAO GLW 4 | wmts |

**`ready:true` but archive missing** — `power_plants` and `gem_coal` have
harvesters and registry entries, but `map/tiles/` contains only
`carbon_bombs.pmtiles`. They show "archive missing" until the refresh workflow
runs and commits them.

**`ready:false`, no harvester, no data** — `carbon_majors`,
`fertilizer_facilities`, `soy_organizations`. These came from my separate maps
repo; neither the archives nor a way to rebuild them is in this repository. They
are marked unbuilt rather than left as rows that always fail. To restore them I
need to supply the `.pmtiles` files or the source data.

**`ready:false`, written, partially run** — `climate_trace`. See below.

---

## Worker routes

    /v1/gfw?bbox=&z=              deforestation via the Data API (unused — see below)
    /v1/fishing?bbox=&z=          4Wings report (kept for one-off analysis, not used by the map)
    /v1/epa_tri?bbox=&z=          EPA Envirofacts TRI
    /v1/epa_cafo?bbox=&z=         EPA Envirofacts V_ICIS_FACILITY_CAFO
    /v1/landmatrix?bbox=&z=
    /v1/fishing_tile/{z}/{x}/{y}  fishing heatmap; ?format=MVT available
    /v1/gfw_tile/{z}/{x}/{y}      alerts; ?kind=integrated|dist|glad_dist &days=N

Diagnostics, read-only, key never leaves the Worker:

    /v1/_diag                     build stamp, secrets visible, cache version
    /v1/_gfw?path=                GFW Data API passthrough
    /v1/_gfwexample               GFW's own documented example, verbatim
    /v1/_epa?path=                Envirofacts passthrough
    /v1/_fishing_mvt/{z}/{x}/{y}  decodes a real MVT tile: source-layer, property keys
    /v1/_fishing_report_status    what the GFW account's single report slot is doing
    /v1/_gfwtiles                 GFW tile-cache routes + whether alerts have a tile asset

`/v1/_diag`'s `routes` list shows only the four bbox routes — the tile routes
are handled earlier and don't appear. Small honesty gap; fold into the next
Worker change.

---

## How the recent layers were built, and the reasoning worth keeping

**Fishing effort — a quota can be account-wide, not connection-wide.** It used
to query `/v3/4wings/report` per viewport and 429'd on almost every pan. Not a
pacing bug: GFW allow one concurrent report *per user account* — not per token,
not per browser — shared across every visitor, with reports running
asynchronously up to 100 s. The in-flight guard, 600 ms debounce and 8 s backoff
were correct engineering aimed at the wrong layer; they'd have worked in solo
testing and failed the moment two people opened the page. Fixed by moving to
`/v3/4wings/tile/heatmap/{z}/{x}/{y}`, which has no report queue. **Before
building a queue, check whether the limit is even per-client.**

**Deforestation alerts — the analysis endpoint was never the render path.**
`POST /dataset/gfw_integrated_alerts/{version}/query/json` returned
`500 {"message":null}` for months, including for GFW's own documented example.
It computes over one area of interest — which is why it wants a tiny polygon and
a date filter and still falls over. WRI run a separate tile service,
`tiles.globalforestwatch.org` (`wri/gfw-tile-cache`), which is what GFW's own
map renders from. Its route is in no documentation and its docs page is
client-rendered, so it was read out of the repo's source:

    GET /gfw_integrated_alerts/{version}/dynamic/{z}/{x}/{y}.png
        ?start_date=&end_date=&render_type=true_color&alert_confidence=low

The handler takes no auth dependency — **no API key**. `version` accepts
`latest` directly. `render_type` defaults to `encoded`, which bit-packs date and
confidence into RGB for client-side decoding; omitting `true_color` renders as
noise.

**Three alert layers, because they do not cover the same planet.** Integrated
alerts combine GLAD-L, GLAD-S2 and RADD, all **pan-tropical by design**. That is
why the layer lights up the Amazon, the Congo and Southeast Asia and shows
nothing in British Columbia or Siberia — a stated extent, not missing data.
Without saying so, a reader would reasonably conclude the boreal forest is
untouched. The two DIST-ALERT layers are global and show temperate and boreal
clearing. Kept separate rather than merged because they detect different things
by different instruments.

**Tile failures are served as transparent PNGs.** The upstream 500s on
individual tiles (z6/11/22 among them) and MapLibre turns any non-200 raster
response into an `AJAXError` that reads as a broken map. The Worker returns a
1×1 transparent PNG with `X-Upstream-Status` and `X-Upstream-Note` headers, so
the failure stays visible to anyone checking without being visible to everyone.

**Alert and GLW rasters start unticked (`off: true`).** A raster that fails to
render covers the viewport in a flat wash — that is what hid every other layer
once. One broken upstream cannot take the map down with it.

**EPA CAFO — column names read tolerantly.** EPA's metadata page for
`V_ICIS_FACILITY_CAFO` disallows automated access, so exact spellings could not
be confirmed. The shaper tries several likely names per field and falls back to
null rather than dropping features. **Still to do:** run
`/v1/_epa?path=V_ICIS_FACILITY_CAFO/rows/0:1/JSON`, read the real names off one
row, pin them.

**FAO GLW — no pipeline at all.** FAO serve WMTS with open CORS and there is no
key, so the map fetches directly. CC BY 4.0. Two quirks recorded in the code:
the tile template puts `TileCol={y}` and `TileRow={x}`, reversed from the usual
convention (swapping them to "fix" it returns wrong tiles); and FAO's own caveat
that lat/long display over-represents density at high latitudes.

---

## Climate TRACE — written, not yet run to completion

Six embeds collapse into this one layer. It took most of a session. What was
wrong, in order:

1. **The download URL was invented.** The old harvester scraped
   `climatetrace.org/data` for `(\d{4}).*global.*\.zip`. No such file exists,
   and that page builds its download list in the browser, so the scrape would
   have found nothing anyway. The real path came from listing the S3 bucket and
   probing candidates:

       downloads.climatetrace.org/latest/sector_packages/<gas>/<sector>.zip

   **The gas segment comes BEFORE the sector.** In no documentation, and what
   every wrong guess got backwards. Verified live: `co2e_100yr/power.zip` → 206,
   `power/co2e_100yr.zip` → 404. The third-party downloader search turns up
   first (`liamlaverty/climate-trace-data-downloader`, last touched 2023) uses a
   path that is now dead.

2. **It read the wrong files.** Each package holds three kinds of CSV:
   asset-level emissions, asset-level *ownership*, and *country-level*
   emissions. The old code read all three as emissions. Now each CSV is
   classified by the columns it actually has — coordinates *and* a quantity —
   rather than by filename, which has shifted between releases.

3. **It ran out of memory.** Sized on `power.zip` at 26.5 MB; `agriculture.zip`
   is **1,424 MB**. It loaded whole archives with `.content` and held every
   parsed row. Killed nine minutes in, locally and on the runner. Now streams to
   a temp file and parses row by row.

4. **Most "sources" are not places.** A test run returned *"Vaca Diez
   Province"* — a whole province as one dot — and agriculture reports 59.8
   million "sources", which are model grid cells, not farms. A layer calling
   those "emitting assets" would state something false.

5. **So precision travels per feature**, read from Climate TRACE's own schema
   (`latest/about_the_data/detailed_data_schema.csv`), whose third column
   `2026_asset-definition` is the distinguishing field, keyed on
   `(sector, subsector)` — both present in the data rows:

       confined-animal-facility        → asset  (solid dot)
       pasture-land-gadm-0-1-2         → admin  (hollow, "not a facility")
       crop-residues-grid-9km-by-9km   → grid   (hollow, cell size in popup)

   Parsed positionally, because the header repeats `sector` and `subsector`
   later in the row and `DictReader` silently keeps the last of each.

6. **All caps removed.** An earlier version kept only the largest emitters until
   95% of each sector's total, under a 60,000-feature ceiling. Those interacted
   and produced a layer carrying **41.7%** of the emissions it claimed to show —
   a figure nobody chose. Removing the cut removed the sorting and the heap with
   it: `fetch()` is now a generator yielding every row, and `harvest.py` writes
   rows one at a time so a harvester may return a generator rather than a list.
   Only rows with no coordinate are dropped, and the count is printed.

7. **The pipeline is gzipped and streaming end to end**, because ~99 million
   features is roughly 30 GB per intermediate and there are two.
   `data/raw/<id>.jsonl.gz` and `data/normalized/<id>.geojsonl.gz`; tippecanoe
   reads gzipped GeoJSON natively. `normalize.py` streams line by line instead
   of `json.loads(read_text())`.

**Where it stands:** the harvest was running locally and its output size is the
open question. ~16 GB free here; a GitHub runner has ~14 GB. If
`data/raw/climate_trace.jsonl.gz` came out above about 5 GB, the answer is
per-sector archives — eight layers instead of one, peak disk becomes the largest
sector rather than the sum, and still nothing dropped.

Also unknown: final `.pmtiles` size. GitHub caps a file at 100 MB; the refresh
workflow already routes oversized archives to R2, whose free tier is 10 GB.

---

## Standards I hold to

**No fabrication.** Provenance for every layer is in `sources.json`, and
rendering must never manufacture a claim. Carbon Bombs has 92 country centroids
among 425 rows, so `precision` travels per feature and centroids render hollow
with a popup saying so. Clustering was removed because a merged feature
inherited one arbitrary member's name and owner — the global dot reported
1,182 Gt as a shelved Canadian coal mine. EPA stores longitude unsigned, so
every US facility plotted in Asia until that was caught.

**No editorial filtering in the pipeline.** Everything the source publishes is
harvested; filtering happens in the map panel where the reader can see and
change it. This is why the Climate TRACE caps came out.

**No pinned URLs.** Every harvester exposes `resolve()` and finds its current
download URL each run.

**Units are never combined.** Each feature carries its own unit.

**A degraded layer beats a blank one, if it says so.** The fishing colour ramp
comes from `/4wings/bins` per zoom; when that fails the Worker draws with a
fallback ramp and reports it in `X-Ramp-Source` rather than throwing. Wrong
thresholds are visible and fixable; a missing layer looks like the source is
down.

---

## Publish blockers (`sources.json`, `_publish_blockers`)

Neither blocks building; both block going public.

- **Carbon Bombs** — `dataforgoodfr/CarbonBombs` declares no licence, which
  defaults to all rights reserved. Underlying GEM trackers are CC BY 4.0 and the
  project list is from Kühne et al., *Energy Policy*. Contact
  hellodataforgood@gmail.com.
- **Land Matrix** — the mirror states two licences for the same data: README
  says CC BY-SA 4.0, its `datapackage.json` says CC BY-NC 4.0. Built against the
  stricter reading.

Climate TRACE's licence has been corrected in `sources.json` to **CC BY 4.0**,
terms at climatetrace.org/terms.

---

## Basemap

Esri World Imagery + Esri World Hillshade + CARTO voyager labels, three raster
sources, graded down so data reads on top. Relief eases in with zoom. Labels sit
above the data.

**Not a full port** of the Leaflet atlas in my other map. That one tints with
CSS blend modes on DOM panes — green wash in soft-light, warmth in overlay, sea
in screen. MapLibre draws raster in WebGL and exposes only opacity, saturation,
brightness, contrast and hue-rotate. **There is no blend mode.** So relief and
grading carry over and the tinting does not; the result reads as graded
satellite with relief rather than the peakery/overworld look I asked for.
Getting the rest means a custom WebGL layer.

An earlier satellite attempt appeared to break the map and was reverted — the
visible symptom was a flat blue wash over everything, which turned out to be a
failing alert raster, not the basemap. A broken raster looks like a broken
basemap.

---

## Still to add — the queue

Verify each endpoint and licence from the source or its capabilities document
BEFORE writing anything. This project has lost hours to inferred URLs; see the
lessons below.

**My own repos — DONE.** Seven harvesters written and run live against
raw.githubusercontent; `probe.py` passes 7/7. They are `ready:false` in
`map/app.js` because no `.pmtiles` exists yet, not because anything is missing —
flip each to true once its archive lands.

| id | rows observed | route |
|---|---|---|
| `local_projects` | 401,100 across 826 tiles | pmtiles, `isolate:true` |
| `gmo_releases` | 43,741 | pmtiles, facet on register |
| `slavery_sites` | 7,552 | pmtiles |
| `slavery_ports` | 3,424 | pmtiles |
| `slavery_fishing` | 2,316 | pmtiles |
| `remains_records` | 4,020 | pmtiles, facet on posture |
| `slavery_cases` | 71 countries | country |

Two bugs came out of running them rather than reading them, and both are the
kind that succeed silently:

- **`remains`' `geo` vocabulary is `exact` / `coarsened` / `area` / `admin`.**
  `coarsened` is the ~5 km blur that repo applies to anything that *is* a burial
  location — 2,580 of 4,020 records. The first mapping did not know the word, so
  all 2,580 fell through to no precision flag and would have drawn as solid,
  precisely located graves. `precision` now fails unknown values safe to
  `unknown`, a `blurred` value was added to the three hollow lists in `app.js`
  with its own popup, and `map/test.mjs` asserts every precision value a
  harvester emits appears in all three lists.
- **CTDC case rows overlap.** Each country carries a grand total *and* a
  type-by-period breakdown that partitions it exactly — the US is 116,418 either
  way. Summing both double-counted every such country and gave a global 418,750
  that no source states. Correct figure is 209,375.

**guerillamap — DONE, and the overlay ids are verified.** `guerillamap.com/shortcuts`
publishes complete prefiltered URLs; the set in `app.js` is their Fossil Fuels
Infrastructure shortcut plus nuclear facilities and NASA FIRMS fires. The driving
mechanism was read out of `conflict-feed/index.html`, which already does this: their
app takes full state from `?coords=&zoom=&grid=&basemap=&overlays=`, one-way, with a
900 ms settle and a proportional south shift for their shorter frame. The panel starts
closed and is toggled from its own row. Some guerillamap layers sit behind a
membership — if one renders empty, check that before blaming the id.

**Cerulean — contract verified, not yet written.** skytruth.org/cerulean-api
redirects to a Colab behind a Google sign-in; the same notebook is readable at
`notebooks/Cerulean API Guide.ipynb` in `SkyTruth/cerulean-cloud`. Both maps are
one collection each:

    /collections/public.slick_plus/items    oil slicks
    /collections/public.source_plus/items   vessels and infrastructure

    ?bbox=&datetime=<start>/<end>&limit=<=9999&offset=&sortby=&filter=<CQL-2>&f=geojson

Default limit is 10 if unspecified. `source_type` is VESSEL / INFRA / DARK /
NATURAL; `source_collated_score` runs -5 to +5 and SkyTruth recommend >0.
**Slick geometry is MultiPolygon**, so the worker route's circle layer would
render nothing — `app.js` needs a fill/line branch before this can ship. Their
own bbox examples read west,north,east,south; send standard OGC order and check
the returned extent on the first live call. Licence still unread.

**Allen Coral Atlas — blocker cleared.** Exactly two feature types, from the WFS
GetCapabilities:

    coral-atlas:benthic_data_verbose
    coral-atlas:geomorphic_data_verbose

`ows:AccessConstraints` reads CC BY 4.0, `ows:Fees` NONE, GetFeature offers
`application/json`, DefaultCRS EPSG:4326, CountDefault 1,000,000. **Declared
extent is -32 to +32 degrees**, not the 30N-30S recorded earlier.

**Trase — licence verified, and the wanted dataset is not the obvious one.**
CC BY 4.0 for charts, graphics, maps and other representations of the data;
commercial use needs info@trase.earth, which does not bind this atlas. 190
datasets. The `supply-chains-*` sets are trade flow between subnational regions,
companies and destinations — a graph, not places, and geocoding it would invent
locations. The mappable ones are the **facilities** datasets: Brazilian
slaughterhouses and meat processing, Indonesian palm mills with UML ids, Ivorian
cocoa cooperatives, and about 9,300 Brazilian soy silos and processing sites with
ownership. Caveat for the layer note: the soy set was identified by an AI vision
workflow Trase state is over 90% accurate, so it is not a register and a share of
it is wrong. `trase.earth/open-data` is server-rendered and paginated, so
`discover.page_link()` can find the current datasets — but **the per-dataset
download URL has not been read yet.**

**PalmWatch — endpoint still unresolved, and the catchments need care.** IDI with
UChicago DSI. Over 2,000 geolocated mills in 32 countries, each carrying which of
13-15 consumer brands source from it, who owns it, and its RSPO status — it names
buyers, which little else here does. Each mill also has a catchment polygon at
roughly 50 km adjusted by road network, with 20 years of UMD tree-cover loss
overlaid and deforestation scores derived from it. **The catchment is a modelled
sourcing area, not a property boundary**, and drawing it beside an owner's name
asserts something the method does not establish; recorded as a publish blocker.
The site is client-rendered, so the download path has to come from its runtime
requests or its source — it is described as open-source, so look for the repo
first. Do not guess a path.

**Still unresearched — endpoint, format and licence all unverified:**

Several of these are web applications that fetch from a backend at runtime, so
they may have usable endpoints; flagged `check_runtime_endpoint` in
`sources.json`. Others unchecked: HydroFATE, Global Wastewater Model, SoilGrids.

**Banking on Climate Chaos** (`bocc`) — harvester exists, discovery returns
nothing because the download page is client-rendered. Same failure mode as the
Climate TRACE page, which was solved by listing the storage bucket rather than
scraping. Also not geocoded; needs sourced bank HQ coordinates. Do NOT use the
Carbon Bombs company file for those — its addresses were generated by ChatGPT.

**Not deployed anywhere:** `the-culprits-atlas.html`, a finished 479 KB
single-file document carrying all 17 sectors of prose and all 63 original
interactives with load-failure fallbacks. Separate from the map.

## Things that wasted hours — don't repeat them

**Check documentation before theorising.** The GFW 500, the fishing 422 and the
fishing 429 each cost several rounds of plausible guesses that reading the docs
would have avoided. The 429 was one sentence in GFW's own reference page.

**When documentation doesn't exist, read the source.** The GFW tile route came
out of `wri/gfw-tile-cache` on GitHub. The Climate TRACE path came out of an S3
bucket listing plus probing. Both were faster than guessing, and neither
produced a wrong answer.

**Global FISHING Watch and Global FOREST Watch are different organisations**
with different keys and different APIs. Their constants collided in the Worker
namespace and wouldn't compile; now `FISHING_4WINGS_BASE` and
`FOREST_TILES_BASE`.

**Three caches sit between a fix and the browser** — the browser, Cloudflare's
edge, and the Worker's own `caches.default`. Bbox routes send `no-store`,
`CACHE_VERSION` is in the cache key, `?fresh=1` bypasses the stored copy. **Bump
`BUILD` and `CACHE_VERSION` on every Worker change** and check `/v1/_diag`
before diagnosing anything. *Exception:* tile routes deliberately send
`max-age`, because a browser refetching every tile on every pan burns the daily
allowance.

**EPA Envirofacts silently ignores range filters.** Asking `tri_facility` for
latitude 33.9–34.1 returns Puerto Rico. Equality filters work, so the Worker
scopes by state (every intersecting state, merged) and applies the bounding box
itself afterwards. The CAFO route does the same.

**Compound assignment reads the left side first.** `p.i += pbVarint(b, p)`
evaluates `p.i` *before* the call advances it, so the cursor movement is
overwritten. This broke the MVT probe's protobuf reader.

**Don't size a pipeline on one measurement.** `power.zip` is 26.5 MB and
`agriculture.zip` is 1,424 MB — fifty-fold. Assume the large case.

---

## Tests — keep them passing

    node worker/test.mjs      # 99 tests, no network
    node map/test.mjs         # 71 tests, no browser
    python3 pipeline/probe.py # can each harvester still find its data

`.github/workflows/check.yml` runs all three on push. The JS tests stub their
libraries strictly and have caught real bugs: a `beforeId` naming a layer that
may not exist, cached responses replayed with the wrong
`Access-Control-Allow-Origin`, `parseInt` producing `zoom=NaN`, `app.js`
executing twice when `index.html` still carried an inline copy, and the protobuf
cursor bug above.

The DOM stub in `map/test.mjs` records event listeners rather than discarding
them, so the layer toggles are testable. Before that, no test could reach a
checkbox.

---

## Immediate queue

1. **Re-run `climate_trace` with the corrected classifier.** This is the live
   correctness problem: the previous run put 51.6 million rows in the `asset`
   class, including rice paddies, fields, reservoirs, road segments and ships.
   The classifier is now written against the real 91 definitions and only 23 of
   them count as facilities. Run it and read the per-definition breakdown — that
   output is the check on the classifier, not my word for it.

       cd ~/Desktop/culprits && source .venv/bin/activate
       export TMPDIR=/Volumes/<DRIVE>/culprits-tmp
       python3 pipeline/harvest.py --only climate_trace --force

   Last full run: 111,949,068 features, 575 MB gzipped, ~40 minutes.

2. `cd worker && npx wrangler deploy` — **v12 is written and tested but not
   deployed.** The EPA CAFO route and the two extra alert layers 404 until it is.
   `/v1/_diag` should then read `v12`.

3. `git push` — `map/app.js` carries the GLW, CAFO and alert layers.

4. Pin the CAFO column names:

       curl -s "$W/v1/_epa?path=V_ICIS_FACILITY_CAFO/rows/0:1/JSON"

   EPA's metadata page disallows automated access, so the shaper currently tries
   several likely spellings per field and falls back to null.

5. Actions → Refresh atlas tiles → force, to build `power_plants` and
   `gem_coal`. Not before step 1 — it would pick up `climate_trace` too.

6. ~~`.gitignore`~~ — done. `.venv/`, `worker/.wrangler/` added; `.DS_Store`
   was already there.

7. Then the source queue above. Own repos and guerillamap are done. **The
   polygon branch in `app.js` is now written**, so Cerulean and Allen Coral need
   only their Worker routes — both are registered in `map/app.js` as
   `ready:false` with `geometry:"polygon"` and their caps and notes already
   settled, so writing the route and flipping the flag is the whole job. After
   those, Trase's facilities datasets, which need one thing found: the
   per-dataset download URL.

8. Add a LICENSE file to each of the five own repos. None of them has one, so
   each currently defaults to all rights reserved — moot for your own use, but
   two of them (`local_projects`, `remains_records`) carry OpenStreetMap rows,
   which are ODbL and share-alike. `local_projects` is marked `isolate:true`;
   `remains_records` is not, because its OSM share is not separable by its
   `register` field yet. Both are recorded in `_publish_blockers`.
