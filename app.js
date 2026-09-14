if (window.__culpritsLoaded) {
  console.warn("[culprits] app.js ran twice — index.html is probably still " +
               "carrying the old inline <script> as well as <script src>. " +
               "Ignoring the second run; layers would otherwise be duplicated " +
               "and only one copy would answer the toggles.");
} else {
  window.__culpritsLoaded = true;

// Where the map stops summarising and starts listing individual culprits.
// Must match CLUSTER_MAXZOOM in pipeline/build_tiles.sh.
const CLUSTER_MAXZOOM = 8;

// Archives live wherever they fit: under 100 MB in the repo, larger ones in R2.
// Both serve HTTP range requests, so the map treats them identically.
const abs = (p) => new URL(p, document.baseURI).href;
const TILE_BASE = abs("./tiles");
const DATA_BASE = abs("./data");
const R2_BASE = "https://tiles.welcometoyourgalaxy.com";
const WORKER = "https://culprits-proxy.welcometoyourgalaxy.workers.dev/v1";

// One entry per layer. `colour` carries identity only — magnitude is encoded
// per layer, because tonnes of CO2e and hectares of land are not comparable
// and a shared size ramp would imply that they are.
// Climate TRACE publishes monthly: 2021-01 through 2026-06, 66 periods, each
// source appearing once per month. Generated rather than listed so extending
// the range is one number.
const CT_MONTHS = (() => {
  const out = [];
  for (let y = 2021; y <= 2026; y++) {
    for (let m = 1; m <= 12; m++) {
      if (y === 2026 && m > 6) break;
      out.push(`${y}-${String(m).padStart(2, "0")}`);
    }
  }
  return out;
})();

// Climate TRACE history, as a group of per-year archives.
//
// One month tiles to about 95 MB and fits in the repo. Twelve months measured
// 1,132 MB with a 375 KB world tile — past GitHub's 100 MB file cap, and a
// world tile every visitor downloads before seeing anything. So the current
// month ships in the repo and the past ships per year, off by default, on R2.
//
// PER YEAR RATHER THAN ONE HISTORY FILE
// PMTiles fetches tiles by range request, but the header and index load per
// archive. One multi-gigabyte history makes every reader pay for an index
// spanning all years; per year they pay for the year they opened. An unticked
// year costs nothing, because the file is never requested. And a finished year
// is finished — 2024 never needs rebuilding.
//
// EMPTY UNTIL THE ARCHIVES EXIST
// Add "2024" here when culprits-tiles/climate_trace_2024.pmtiles is on R2, and
// the group appears. With no years the parent row is not rendered at all,
// rather than offering toggles that 404 — an archive-missing row reads as a
// broken map, which is the same reason unbuilt sources are named at the bottom
// instead of listed as dead checkboxes.
const CT_HISTORY_BASE = "https://tiles.welcometoyourgalaxy.com";
const CT_HISTORY_YEARS = [];

// Climate TRACE by sector, as one parent with a child per sector.
//
// One month of all sectors is 1,696,198 features and tiles to ~475 MB — past
// GitHub's 100 MB file cap. Split by sector each archive fits in the repo, so
// there is no object store, no account and no proxy in front of every tile.
//
// It is also the better map. One switch for "all emissions" is not how the rest
// of this atlas works: coal, power plants and carbon bombs are separate layers
// because they measure different things, and cropland fires and electricity
// differ at least as much. Split, a reader can look at power without
// agriculture drowning it — agriculture alone is 59.9M of the 112M rows.
//
// FILL THIS IN FROM WHAT ACTUALLY BUILT
// pipeline/split_sectors.sh discovers sectors from the data and prints the ids
// it built. List them here. An id with no archive shows as "archive missing",
// so add a sector only once its .pmtiles exists.
const CT_SECTORS = {
  id: "climate_trace_sectors",
  name: "Climate TRACE — emitting assets",
  group: true,
  ready: true,
  children: [].map((slug) => ({
    id: `climate_trace_${slug}`,
    name: slug.replace(/_/g, " "),
    unit: "t CO\u2082e/yr (GWP-100)",
    colour: "#8F4E40",
    route: "pmtiles",
    ready: true,
    lazy: true,
    // Learned from each archive, because a sector holds only the months and
    // asset definitions it actually has.
    facet: { property: "x_period", label: "month", values: [] },
  })),
};

const CT_HISTORY = {
  id: "ct_history",
  name: "Historical",
  group: true,
  ready: true,
  children: CT_HISTORY_YEARS.map((y) => ({
    id: `climate_trace_${y}`,
    name: String(y),
    unit: "t CO\u2082e/yr (GWP-100)",
    colour: "#8F4E40",
    route: "pmtiles",
    ready: true,
    // Not created at load. The source and its layers are added the first time
    // the box is ticked, so ten unopened years cost ten zero requests.
    lazy: true,
    archiveUrl: `${CT_HISTORY_BASE}/climate_trace_${y}.pmtiles`,
    // Months come from the archive's own metadata, not from CT_MONTHS. A year
    // archive holds twelve months and the shared constant holds sixty-six, so
    // using the constant would offer fifty-four months that render nothing.
    facet: { property: "x_period", label: "month", values: [] },
    note: `Climate TRACE emissions for ${y}, monthly.`,
  })),
};

const LAYERS = [
  { id:"owid_co2",             name:"National CO₂ emissions", unit:"Mt CO₂/yr", colour:"#8A5750", route:"country", ready:true },
  // Every row is ONE MONTH for one source, not one facility: 2021-01 through
  // 2026-06, 66 rows per source, confirmed from the harvest. Without a facet
  // the map stacks 66 coincident dots on every facility and the popup shows
  // one arbitrary month with no date on it.
  //
  // A facet rather than a cut: nothing is dropped, and the reader can see and
  // change which month they are looking at. Defaults to the latest so the map
  // opens showing one dot per facility.
  // Everything Climate TRACE locates, confined animal facilities included —
  // this is the complete emissions layer and nothing is held back from it.
  { id:"climate_trace",        name:"Emitting assets",         unit:"t CO₂e/yr (GWP-100)", colour:"#8F4E40", route:"pmtiles", ready:false,
    facet: { property: "x_period", label: "month", values: CT_MONTHS,
             // One month selected on load. Every other month is one click away.
             defaultValues: [CT_MONTHS[CT_MONTHS.length - 1]] },
    note: "Monthly, 2021-01 to 2026-06. One month is shown at a time — pick others in the panel." },

  // The same facilities again, as LOCATIONS rather than as emissions. Drawn at
  // one size regardless of magnitude, because the question this layer answers
  // is "where are they", not "which are worst" — and 37.7 million of the 47.9
  // million asset-level rows are this one definition, so sized by emissions it
  // is unreadable anyway.
  //
  // `sourceOf` points it at the emissions layer's PMTiles archive, so this
  // costs no second harvest and no second download: two panel rows, one file.
  //
  // Modelled, not registered — see the note. A point here is Climate TRACE's
  // estimate that a facility exists, not a permit or an inspection.
  { id:"climate_trace_cafo",   name:"Confined animal facilities (global)", unit:"locations", colour:"#7B6A4E", route:"pmtiles", ready:false,
    sourceOf: "climate_trace",
    where: ["==", ["get", "x_asset_definition"], "confined-animal-facility"],
    uniformRadius: true,
    facet: { property: "x_period", label: "month", values: CT_MONTHS,
             defaultValues: [CT_MONTHS[CT_MONTHS.length - 1]] },
    note: "Locations only — dots are one size and do not encode emissions. Modelled by Climate TRACE from satellite and census data, not a permit register: a point here has not necessarily been inspected or licensed." },
  { id:"gem_coal",             name:"Coal plant units",        unit:"MW capacity", colour:"#7A5548", route:"pmtiles", ready:true,
    facet: { property: "x_status", label: "status",
             values: ["operating","construction","permitted","pre-permit","announced",
                      "shelved","mothballed","retired","cancelled"] } },
  { id:"global_energy_monitor",name:"GEM's other trackers",     unit:"capacity",   colour:"#7A5548", route:"pmtiles", ready:false },
  { id:"carbon_bombs",         name:"Carbon bombs",            unit:"Gt CO₂ lifetime", colour:"#6E4A44", route:"pmtiles", ready:true },
  { id:"power_plants",         name:"Power plants",            unit:"MW capacity", colour:"#7E5A4E", route:"pmtiles", ready:true,
    // The source covers every fuel and nothing is filtered out of the data.
    // Filtering happens here instead, where it is visible and reversible.
    facet: { property: "x_fuel", label: "fuel",
             values: ["Coal","Gas","Oil","Petcoke","Nuclear","Hydro","Wind","Solar",
                      "Biomass","Waste","Geothermal","Storage","Cogeneration",
                      "Wave and Tidal","Other"] } },
  // The next three carry no harvester and no entry in sources.json: their data
  // came from the separate maps repo, and neither the archive nor a way to
  // rebuild it is in this repository. Listing them as live layers put a row in
  // the panel that always failed with "archive missing", which reads as a
  // broken map rather than an unbuilt source. ready:false names them once in
  // the unbuilt list instead, which is what the panel is for. Flip back to true
  // once map/tiles/<id>.pmtiles exists, or once a harvester is registered.
  { id:"carbon_majors",        name:"Carbon major HQs",        unit:"company headquarters", colour:"#7E6B8F", route:"pmtiles", ready:false },
  { id:"fertilizer_facilities",name:"Fertilizer plants",       unit:"ammonia / urea", colour:"#8A7C5C", route:"pmtiles", ready:false },
  { id:"soy_organizations",    name:"Soy industry bodies",     unit:"trade organisations", colour:"#6F7F72", route:"pmtiles", ready:false },
  { id:"trase",                name:"Commodity supply chains", unit:"ha",         colour:"#62755F", route:"pmtiles", ready:false },
  { id:"land_matrix",          name:"Land deals",              unit:"hectares",   colour:"#6C7F63", route:"country", ready:true,  isolate:true },
  { id:"counterglow",          name:"Industrial animal farms", unit:"facilities", colour:"#7B7A5C", route:"pmtiles", ready:false },
  { id:"epa_tri",              name:"US toxic release sites",  unit:"TRI facilities", colour:"#5C6E77", route:"worker",  ready:true,
    // Upstream returns at most 500 rows per request, so a very large viewport
    // would show an arbitrary 500 rather than everything. Capped to keep what
    // is drawn honest rather than a truncated sample presented as complete.
    // Raised from 25 so sites appear roughly two zoom levels earlier. The cap
    // exists because upstream returns at most 500 rows, so a viewport wider
    // than this would show an arbitrary 500 presented as the whole picture.
    maxAreaDeg2: 100 },
      // Disabled pending GFW. Their raster query endpoint returns
  // 500 {"message":null} for every request tried, including GFW's own
  // documented example, on fully built dataset versions. Route, shaper, version
  // resolver and tests all stay — this is one flag to flip when it works.
  // Also a tile layer, and for the same reason as fishing. /query/json is an
  // analysis endpoint: it computes over one area of interest, which is why it
  // wants a tiny polygon and a date filter and still returned 500s. WRI runs a
  // separate tile service that GFW's own map renders from, and its integrated
  // alerts route needs no API key. Colour and confidence come from upstream:
  // alert_confidence=low means every alert published, filtered nowhere.
  // FAO's Gridded Livestock of the World, served as raster tiles from FAO's own
  // WMTS rather than harvested. Six species at ~10 km, CC BY 4.0.
  //
  // A model, not an inventory: densities are downscaled from subnational census
  // data by random forest, so a bright cell means "the model puts animals here",
  // not "a farm is here". Kept as a separate layer from the permitted CAFOs for
  // exactly that reason — one is a register, the other is a surface.
  //
  // FAO's own caveat, worth repeating: the data is lat/long, which visually
  // over-represents density at high latitudes because those pixels cover less
  // ground. Greenland and Siberia read hotter than they are.
  ...["cattle:CTL:#6E5A44", "pigs:PGS:#7A5560", "chicken:CHK:#6B6A4A",
      "buffalo:BFL:#5C5245", "goats:GTS:#6F6552", "sheep:SHP:#5F6659"]
    .map((spec) => {
      const [animal, code, colour] = spec.split(":");
      return {
        id: `glw_${animal}`,
        name: `Livestock density — ${animal}`,
        unit: "head/km² (modelled, 2020)",
        colour,
        route: "wmts",
        ready: true,
        off: true,
        wmtsLayer: `fao-gismgr/GLW4-2020/mapsets/D-DA-${code}`,
        note: "Modelled density downscaled from census data, not a facility " +
              "register. FAO note that lat/long display over-represents high " +
              "latitudes.",
        attribution: '<a href="https://data.apps.fao.org/catalog/organization/' +
                     'gridded-livestock-of-the-world-glw" target="_blank" ' +
                     'rel="noopener">FAO Gridded Livestock of the World 4</a> (CC BY 4.0)',
      };
    }),

  // Three alert layers, not one, because they do not cover the same planet.
  //
  // "Integrated" combines GLAD-L, GLAD-S2 and RADD, and all three are
  // PAN-TROPICAL by design. That is why it lights up the Amazon, the Congo
  // basin and Southeast Asia and shows nothing in British Columbia, Sweden or
  // Siberia: not missing data, a stated extent. Anyone reading the map without
  // that stated would reasonably conclude the boreal forest is untouched.
  //
  // The two DIST layers are global vegetation-disturbance products, and they
  // are what shows clearing outside the tropics.
  //
  // They are kept separate rather than merged because they detect different
  // things by different instruments, and a reader who sees an alert should be
  // able to tell which one saw it.
  { id:"gfw",                  name:"Deforestation alerts — tropics",  unit:"GLAD + RADD, last 30 days", colour:"#55705E", route:"tile", ready:true,
    tileMaxZoom: 22, tileQuery: "kind=integrated&days=30", off: true,
    note: "Pan-tropical only. GLAD and RADD do not cover boreal or temperate forest — use the global layers for those.",
    attribution: '<a href="https://www.globalforestwatch.org" target="_blank" rel="noopener">Global Forest Watch</a>' },
  { id:"gfw_dist",             name:"Disturbance alerts — global",     unit:"DIST-ALERT, last 30 days", colour:"#6E7A55", route:"tile", ready:true,
    tilePath: "gfw_tile", tileMaxZoom: 22, tileQuery: "kind=dist&days=30", off: true,
    note: "Global coverage, including boreal and temperate forest. Detects vegetation disturbance generally, so it catches fire and harvest as well as clearing.",
    attribution: '<a href="https://www.globalforestwatch.org" target="_blank" rel="noopener">Global Forest Watch</a>' },
  { id:"gfw_dist_year",        name:"Disturbance alerts — past year",  unit:"DIST-ALERT, last 365 days", colour:"#7E6F4E", route:"tile", ready:true,
    tilePath: "gfw_tile", tileMaxZoom: 22, tileQuery: "kind=dist&days=365", off: true,
    note: "The same global product over a twelve-month window, for seeing a season's cumulative loss rather than this month's.",
    attribution: '<a href="https://www.globalforestwatch.org" target="_blank" rel="noopener">Global Forest Watch</a>' },
  // Not a "worker" route any more, and not points.
  //
  // This used to query /v3/4wings/report per viewport and returned 429 on
  // almost every pan. That was not a pacing bug. GFW allows one concurrent
  // report per account, shared across everyone who opens this page, and a
  // report runs asynchronously for up to 100 seconds. Two readers at once
  // were already over the limit, so no amount of debouncing here could have
  // fixed it.
  //
  // The 4Wings tile endpoint has no report queue, and fishing effort is a
  // continuous field rather than a set of sites, so a heatmap says what the
  // data actually is. Attribution is required by GFW's terms of use.
  { id:"fishing",              name:"Fishing effort",          unit:"apparent fishing hours, 12 months", colour:"#4F6773", route:"tile", ready:true,
    tileMaxZoom: 12,
    attribution: '<a href="https://globalfishingwatch.org" target="_blank" rel="noopener">Powered by Global Fishing Watch</a>' },

  // ---- the other maps in this suite -------------------------------------
  //
  // Seven layers out of five repos in the WelcomeToYourGalaxy org. Their
  // harvesters are written and have been run against live data; what does not
  // exist yet is map/tiles/<id>.pmtiles, because the refresh workflow has not
  // built them. So they are ready:false — not because anything is missing, but
  // because ready:true with no archive puts a row in the panel reading
  // "archive missing", and that has been reported as a broken map three times.
  // Flip each to true once its archive lands.
  { id:"local_projects",       name:"Development projects",    unit:"acres, where the register states them", colour:"#6E7B84", route:"pmtiles", ready:false,
    isolate:true,
    note: "401,100 filings from 68 registers — mines, pipelines, LNG, offshore wind, and the environmental reviews that precede them. What is about to be built, at the point where it is still a filing." },
  { id:"gmo_releases",         name:"Genetic-engineering releases", unit:"authorisations", colour:"#7C6F84", route:"pmtiles", ready:false,
    facet: { property: "x_register", label: "register",
             values: ["US APHIS BRS","industry register",
                      "CBD Biosafety Clearing-House","clinical trial sponsor",
                      "Australia OGTR"] },
    note: "96% of these records carry no site coordinate. APHIS publishes the state a release was authorised in and never the field, so most draw hollow at a state centroid." },
  { id:"slavery_sites",        name:"Brick kilns and artisanal mining", unit:"sites", colour:"#8A6B62", route:"pmtiles", ready:false,
    note: "Sector infrastructure, not confirmed exploitation. These are sites in sectors where forced and child labour concentrate; where IPIS actually observed it, the site says so." },
  { id:"slavery_ports",        name:"Ports with high-risk vessel calls", unit:"ports", colour:"#5F7480", route:"pmtiles", ready:false,
    note: "Scored on the share of calling fishing vessels flagged high-risk by a published behavioural model. A property of the calls, not of the port." },
  { id:"slavery_fishing",      name:"Modelled at-risk fishing effort", unit:"model cells, 2.5°", colour:"#4E6A70", route:"pmtiles", ready:false,
    note: "Not vessels. The authors anonymised every hull, so each mark is a cell of ocean and identifies nobody." },
  { id:"remains_records",      name:"Unearthings and burial decisions", unit:"records", colour:"#6A6257", route:"pmtiles", ready:false,
    facet: { property: "x_posture", label: "direction",
             values: ["harm","watch","redress","unlawful"] },
    note: "This layer does not plot graves. Burial locations arrive blurred to about 5 km from the source and stay that way. Direction is separate from size: a large repatriation is a large event, not a bad one." },
  { id:"slavery_cases",        name:"Identified trafficking cases", unit:"identified cases", colour:"#7A6A72", route:"country", ready:false,
    note: "Detection, not prevalence. A country with a large count has organisations filing records; a country with none may have no one counting." },

  // ---- verified contracts, worker routes not written yet -----------------
  //
  // Registered here rather than left out so the geometry, the caps and the
  // wording are settled while the API documentation is fresh. All three are
  // polygons, which is why addLiveLayer grew a fill/line branch. Each needs a
  // Worker route before ready can flip.
  { id:"cerulean_slicks",      name:"Oil slicks (Cerulean)",   unit:"potential slicks, Sentinel-1", colour:"#5A5750", route:"worker", ready:false,
    geometry:"polygon", maxAreaDeg2: 120,
    note: "Potential slicks. SkyTruth state that oil cannot be definitively identified from radar alone, so every shape here is a detection awaiting review. Coverage is EEZs rather than the high seas.",
    attribution: '<a href="https://cerulean.skytruth.org" target="_blank" rel="noopener">SkyTruth Cerulean</a>' },
  { id:"cerulean_sources",     name:"Slick sources (Cerulean)", unit:"candidate vessels and platforms", colour:"#6B5F58", route:"worker", ready:false,
    geometry:"polygon", maxAreaDeg2: 120,
    note: "Candidates, ranked. The score is an estimated likelihood on a -5 to +5 scale, not a finding, and vessel identity lags up to 72 hours behind the detection. This layer names parties and must read as a question rather than an answer.",
    attribution: '<a href="https://cerulean.skytruth.org" target="_blank" rel="noopener">SkyTruth Cerulean</a>' },
  { id:"allen_coral",          name:"Coral reef habitat",      unit:"benthic and geomorphic zones", colour:"#5E7377", route:"worker", ready:false,
    geometry:"polygon", maxAreaDeg2: 40,
    note: "Mapped between 32°N and 32°S only, which is the product's stated extent and not an absence of reefs elsewhere. Benthic zones to 10 m depth, geomorphic to 15 m.",
    attribution: '<a href="https://allencoralatlas.org" target="_blank" rel="noopener">Allen Coral Atlas</a> (CC BY 4.0)' },
];

const protocol = new pmtiles.Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);

const map = new maplibregl.Map({
  container: "map",
  center: [12, 24],
  zoom: 1.6,
  attributionControl: { compact: true },
  style: {
    version: 8,
    sources: {
      // Imagery, relief and labels as three layers, the way the Leaflet atlas
      // builds them. What this map documents is physical — a mine, a cleared
      // block, a plantation edge — and on a drawn basemap those float over an
      // abstraction rather than sitting on the ground they refer to.
      //
      // NOT a full port. The Leaflet version tints with CSS blend modes on DOM
      // panes: a green wash in soft-light, warmth in overlay, sea in screen.
      // MapLibre draws raster in WebGL and exposes only opacity, saturation,
      // brightness, contrast and hue-rotate — there is no blend mode. So the
      // relief and the grading carry over and the tinting does not. Saying that
      // plainly rather than shipping something close and calling it the same.
      base: {
        type: "raster",
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/" +
                "World_Imagery/MapServer/tile/{z}/{y}/{x}"],
        tileSize: 256, maxzoom: 18,
        attribution: "Imagery © Esri, Maxar",
      },
      // Relief is what makes imagery read as terrain rather than as a
      // photograph. In the Leaflet map it multiplies; here it can only sit on
      // top at low opacity, which is weaker but the same idea.
      hillshade: {
        type: "raster",
        tiles: ["https://services.arcgisonline.com/arcgis/rest/services/" +
                "Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}"],
        tileSize: 256, maxzoom: 16,
        attribution: "Hillshade © Esri",
      },
      // Labels only — coastlines and place names over the imagery. Without
      // them satellite is unreadable at low zoom: no way to tell which coast.
      labels: {
        type: "raster",
        tiles: ["https://a.basemaps.cartocdn.com/rastertiles/" +
                "voyager_only_labels/{z}/{x}/{y}@2x.png"],
        tileSize: 256,
        attribution: "Labels © CARTO, © OpenStreetMap",
      },
    },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": "#0B1017" } },
      // Graded down so the data layers read on top. Raw Esri imagery is bright
      // enough that a muted point layer disappears into it.
      { id: "base", type: "raster", source: "base",
        paint: { "raster-opacity": 1, "raster-brightness-max": .74,
                 "raster-saturation": -.22, "raster-contrast": .10 } },
      // Relief eases IN as you zoom, the way the Leaflet ramp does it: wide out
      // it muddies the picture, at valley scale it is what you want more of.
      { id: "hillshade", type: "raster", source: "hillshade",
        paint: { "raster-opacity":
          ["interpolate", ["linear"], ["zoom"], 4, .18, 9, .34, 13, .46] } },
    ],
  },
});

map.on("error", (e) => {
  const id = e.sourceId || "";
  const cfg = LAYERS.find((l) => id.startsWith(l.id));
  const msg = (e.error && e.error.message) || "failed to load";
  if (cfg) setLayerState(cfg.id, msg);
  console.error("[culprits]", id || "map", msg, e.error || e);
});

map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
map.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: "metric" }), "bottom-right");

/* ---------- pre-tiled layers ---------- */

// Read a facet's values out of the archive rather than declaring them.
//
// tippecanoe writes per-attribute value lists into the tile metadata, so the
// months an archive actually holds are recorded in the file. Reading them means
// a facet can never offer a month the archive lacks, or omit one it gained —
// the two ways a hardcoded CT_MONTHS goes wrong, in opposite directions, as
// soon as the build granularity or the publishing schedule changes.
//
// The instance is registered with the same protocol the map uses, so this costs
// no second header fetch.
async function learnFacetValues(cfg, url) {
  try {
    const archive = new pmtiles.PMTiles(url);
    protocol.add(archive);
    const md = await archive.getMetadata();
    const values = facetValuesFrom(md, cfg.facet.property);
    if (!values.length) throw new Error("no recorded values for " + cfg.facet.property);
    cfg.facet.values = values;
    refreshFacetRow(cfg);
  } catch (e) {
    console.warn(`[culprits] ${cfg.id}: could not read facet values from the ` +
                 `archive (${e.message}). The declared list stands.`);
  }
}

// tippecanoe has written this in more than one shape across versions: a
// top-level `tilestats`, or a `json` key holding either a string or an object.
// All three are tried rather than assuming the one this build happens to emit.
function facetValuesFrom(md, property) {
  if (!md) return [];
  let stats = md.tilestats;
  if (!stats && md.json) {
    try {
      const j = typeof md.json === "string" ? JSON.parse(md.json) : md.json;
      stats = j.tilestats;
    } catch (_) { /* not JSON; fall through to the empty list */ }
  }
  const layers = (stats && stats.layers) || [];
  const out = new Set();
  for (const layer of layers) {
    for (const attr of layer.attributes || []) {
      if (attr.attribute !== property) continue;
      for (const v of attr.values || []) out.add(String(v));
    }
  }
  return [...out].sort();
}

async function addPmtilesLayer(cfg) {
  // A layer may draw from another layer's archive — see climate_trace_cafo.
  // The source and source-layer keep the OWNER's id; only the map layers and
  // the filter belong to this one.
  const owner = cfg.sourceOf || cfg.id;
  // History years live on R2, not in the repo, so a layer may name its own
  // archive. Everything else resolves against the repo's tiles directory.
  const url = cfg.archiveUrl || `${TILE_BASE}/${owner}.pmtiles`;
  try {
    const head = await fetch(url, { method: "HEAD" });
    if (!head.ok) throw new Error(`${head.status} at ${url}`);
  } catch (e) {
    setLayerState(cfg.id, `archive missing (${e.message})`);
    console.error(`[culprits] ${cfg.id}: ${e.message}`);
    return;
  }

  const src = `${owner}-src`;
  // Added once; a second layer over the same archive reuses it.
  if (!map.getSource(src)) {
    map.addSource(src, { type: "vector", url: `pmtiles://${url}` });
    // An archive that declares its own facet values is asked for them, so a
    // year archive offers its twelve months rather than the shared list's
    // sixty-six. Failure here is not fatal: the declared list stands and the
    // reason is logged, because a facet that silently empties looks like a
    // layer with no data.
    if (cfg.facet && Array.isArray(cfg.facet.values) && cfg.facet.values.length === 0) {
      learnFacetValues(cfg, url);
    }
  }

  // Aggregate view. tippecanoe summed `value` into the clustered features, so
  // radius can encode magnitude *within this layer* without claiming anything
  // about any other.
  map.addLayer({
    id: `${cfg.id}-agg`,
    type: "circle",
    source: src,
    "source-layer": owner,
    ...(cfg.where ? { filter: cfg.where } : {}),
    maxzoom: CLUSTER_MAXZOOM,
    paint: {
      "circle-color": cfg.colour,
      "circle-opacity": .55,
      "circle-stroke-color": cfg.colour,
      "circle-stroke-width": 1,
      // Two cases share this layer. Large sources are clustered, so _count is
      // how many sites a dot stands for. Small sources are not clustered, so
      // every _count is 1 and size must come from the magnitude instead —
      // otherwise every dot renders at the minimum and the map reads flat.
      // Radius is scaled by zoom as well as by magnitude. Sized on magnitude
      // alone, a 10,000-site cluster drew a 26px disc at z2, and half a dozen
      // of those covered whole continents in overlapping blobs — the global
      // view showed less than a blank map would. The multiplier keeps the
      // relative sizes intact (a big cluster is still visibly bigger than a
      // small one) while shrinking everything at the zooms where they collide.
      "circle-radius": [
        "*",
        ["interpolate", ["linear"], ["zoom"], 0, 0.55, 4, 0.72, 7, 0.9, 10, 1],
        [
          "case",
          [">", ["coalesce", ["get", "_count"], 1], 1],
          ["interpolate", ["linear"], ["get", "_count"],
            1, 4, 10, 7, 100, 11, 1000, 17, 10000, 23],
          ["interpolate", ["linear"], ["sqrt", ["coalesce", ["get", "value"], 0]],
            0, 2.5, 1, 4, 3, 7, 6, 12],
        ],
      ],
    },
  });

  // Individual features, from the threshold up. Only the visible tiles are
  // fetched, by range request, so this costs what the viewport costs.
  map.addLayer({
    id: `${cfg.id}-pt`,
    type: "circle",
    source: src,
    "source-layer": owner,
    ...(cfg.where ? { filter: cfg.where } : {}),
    minzoom: CLUSTER_MAXZOOM,
    paint: {
      "circle-color": cfg.colour,
      "circle-opacity": .75,
      "circle-stroke-color": "#17150F",
      "circle-stroke-width": .6,
      // A location layer draws every point the same size. Encoding magnitude
      // here would say "this farm matters more", which is not what the layer
      // is for, and with 37.7 million points it would read as noise regardless.
      "circle-radius": cfg.uniformRadius
        ? ["interpolate", ["linear"], ["zoom"], 8, 2.5, 14, 4.5]
        : ["interpolate", ["linear"], ["zoom"], 8, 3.5, 14, 7],
      // Anything that is not a located facility is hollow, so it never reads
      // as one. Seven kinds: a country centroid, an administrative unit
      // (GADM province, GHS urban area), a model grid cell, an area (paddies,
      // fields, reservoirs), a road or rail segment, a vessel, and rows the
      // source gives no definition for. Every one of them is a point standing
      // in for something that is not a point.
      //
      // Only genuine facilities render solid: plants, mines, ports, airports,
      // refineries, waste sites — 23 of Climate TRACE's 91 definitions.
      "circle-opacity": ["case", ["in", ["get", "x_precision"],
        ["literal", ["country", "admin", "grid", "area", "segment", "mobile", "blurred", "unknown"]]], 0, .75],
      "circle-stroke-color": ["case", ["in", ["get", "x_precision"],
        ["literal", ["country", "admin", "grid", "area", "segment", "mobile", "blurred", "unknown"]]], cfg.colour, "#17150F"],
      "circle-stroke-width": ["case", ["in", ["get", "x_precision"],
        ["literal", ["country", "admin", "grid", "area", "segment", "mobile", "blurred", "unknown"]]], 1.4, .6],
    },
  });

  // Both layers, not just the detail one: below the cluster threshold the
  // aggregate layer is the only thing on screen, and it was unclickable.
  bindPopup(`${cfg.id}-agg`);
  bindPopup(`${cfg.id}-pt`);
  applyVisibility(cfg.id);
}

/* ---------- country aggregate layers (choropleth) ---------- */

// Some sources have no coordinates — only totals per country. Those draw
// against real national borders rather than centroids, because a centroid
// dressed as a point claims a location the source never gave.
let boundariesAdded = false;

// Choropleth fills belong under the point layers so they don't hide them. But
// the point layers are added asynchronously too, so the id may not exist yet —
// and MapLibre throws on a beforeId that isn't there. Return undefined in that
// case and let the fill go on top; ordering is cosmetic, a thrown error is not.
function pointLayerAbove() {
  for (const l of LAYERS) {
    if (l.ready && l.route !== "country" && map.getLayer(`${l.id}-agg`)) {
      return `${l.id}-agg`;
    }
  }
  return undefined;
}

async function addCountryLayer(cfg) {
  if (!boundariesAdded) {
    map.addSource("boundaries", { type: "geojson", data: `${DATA_BASE}/boundaries.geojson`,
                                  promoteId: "iso3" });
    boundariesAdded = true;
  }

  let totals;
  try {
    const r = await fetch(`${DATA_BASE}/${cfg.id}.countries.json`);
    if (!r.ok) throw new Error(`${r.status}`);
    totals = await r.json();
  } catch (e) {
    setLayerState(cfg.id, `unavailable (${e.message})`);
    return;
  }

  const values = Object.values(totals).map((t) => t.value).filter((v) => v > 0);
  const max = Math.max(...values, 1);
  const min = Math.min(...values);

  // Log scale, not linear or square-root. These distributions are extremely
  // heavy-tailed: China emits 12,289 Mt against a median country's 11.8, so a
  // square-root ramp gave the median an opacity of 0.02 — data present, nothing
  // visible. Log spreads the middle of the range where most countries sit.
  //
  // OPACITY_FLOOR keeps the smallest reporting country distinguishable from a
  // country with no data at all, which must stay fully transparent.
  const OPACITY_FLOOR = 0.12, OPACITY_CEIL = 0.72;
  const lo = Math.log10(Math.max(min, 1e-6));
  const span = Math.max(Math.log10(max) - lo, 0.001);

  // Country layers share one boundaries source, so each needs its own
  // feature-state key. A shared "v" meant the second layer to load silently
  // overwrote the first's values for every country.
  const key = `v_${cfg.id}`;

  map.addLayer({
    id: `${cfg.id}-fill`,
    type: "fill",
    source: "boundaries",
    paint: {
      "fill-color": cfg.colour,
      // Square root, not linear: one country holding a third of the total
      // would otherwise flatten every other country to invisible.
      "fill-opacity": [
        "case", ["==", ["feature-state", key], null], 0,
        ["+", OPACITY_FLOOR, ["*", OPACITY_CEIL - OPACITY_FLOOR,
          ["/", ["-", ["log10", ["max", ["feature-state", key], 1e-6]], lo], span]]],
      ],
    },
  }, pointLayerAbove());

  map.addLayer({
    id: `${cfg.id}-line`,
    type: "line",
    source: "boundaries",
    paint: {
      "line-color": cfg.colour,
      "line-width": 0.6,
      "line-opacity": ["case", ["==", ["feature-state", key], null], 0, 0.55],
    },
  });

  for (const [iso, t] of Object.entries(totals)) {
    // Merge rather than replace: another country layer may already hold state
    // on this feature.
    map.setFeatureState({ source: "boundaries", id: iso }, {
      [key]: t.value,
      [`${key}_unit`]: t.unit,
      [`${key}_note`]: t.x_deals ? `${t.x_deals} deals`
                     : t.x_share_global ? `${t.x_share_global}% of global`
                     : null,
    });
  }

  map.on("click", `${cfg.id}-fill`, (e) => {
    const st = map.getFeatureState({ source: "boundaries", id: e.features[0].id });
    if (st[key] == null) return;
    new maplibregl.Popup({ maxWidth: "280px" })
      .setLngLat(e.lngLat)
      .setHTML(
        `<b>${e.features[0].properties.name}</b>` +
        `${Number(st[key]).toLocaleString()} ${st[`${key}_unit`] || ""}` +
        (st[`${key}_note`] ? `<div class="meta">${st[`${key}_note`]}</div>` : "") +
        `<div class="meta" style="color:#8F4E40">Country total — the source ` +
        `records no site coordinates for these.</div>`
      )
      .addTo(map);
  });
  map.on("mouseenter", `${cfg.id}-fill`, () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", `${cfg.id}-fill`, () => (map.getCanvas().style.cursor = ""));
  applyVisibility(cfg.id);
}

/* ---------- live layers, via the Worker ---------- */

const liveCache = new Map();

async function refreshLiveLayer(cfg) {
  const b = map.getBounds();
  const west = Math.max(b.getWest(), -180), east = Math.min(b.getEast(), 180);
  const south = Math.max(b.getSouth(), -90), north = Math.min(b.getNorth(), 90);

  // No fixed zoom threshold. Live layers load at whatever zoom the source can
  // answer for — which differs by source, because a request covering half the
  // planet is a different thing to EPA than it is to a 10 m alert raster.
  const area = (east - west) * (north - south);
  const cap = cfg.maxAreaDeg2 || 25;
  if (area > cap) {
    setLayerState(cfg.id, `zoom in — area too wide for this source`);
    const src = map.getSource(`${cfg.id}-live`);
    if (src) src.setData({ type: "FeatureCollection", features: [] });
    return;
  }

  const bbox = [west, south, east, north].map((n) => n.toFixed(3)).join(",");

  if (inFlight.get(cfg.id)) return;   // one at a time; the settle timer retries
  if (liveCache.get(cfg.id) === bbox) return;    // same viewport, already have it
  liveCache.set(cfg.id, bbox);

  const src = map.getSource(`${cfg.id}-live`);
  if (!src) return;
  inFlight.set(cfg.id, true);
  try {
    setLayerState(cfg.id, "loading…");
    const r = await fetch(`${WORKER}/${cfg.id}?bbox=${bbox}&z=${Math.round(map.getZoom())}`);
    if (!r.ok) {
      // Surface the Worker's own explanation, which names the upstream problem,
      // rather than a bare status code.
      let detail = `${r.status}`;
      try { detail = (await r.json()).error || detail; } catch (_) {}
      throw new Error(detail);
    }
    const geo = await r.json();
    src.setData(geo);
    const n = (geo.features || []).length;
    setLayerState(cfg.id, n ? `${n.toLocaleString()} in view` : "none in this area");
    console.log(`[culprits] ${cfg.id}: ${n} features for ${bbox}`);
  } catch (e) {
    // A live source failing is not a reason for the map to fail. The layer
    // stays empty and says so rather than throwing.
    const busy = /429|Too Many Requests|concurrent/.test(e.message);
    setLayerState(cfg.id, busy
      ? "the source is still finishing the last request — pausing, then retrying"
      : `unavailable (${e.message})`);
    if (busy) {
      // The previous report is still running upstream. Forget the cached
      // viewport so the next attempt actually re-requests it.
      liveCache.delete(cfg.id);
      setTimeout(() => refreshLiveLayer(cfg), 8000);
    }
  } finally {
    inFlight.set(cfg.id, false);
  }
}

function addLiveLayer(cfg) {
  map.addSource(`${cfg.id}-live`, {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  // Not every live source is a set of points.
  //
  // Cerulean returns oil slicks as MultiPolygon, and the slick's shape is the
  // evidence: a long thin streak behind a transiting vessel is what makes the
  // detection a bilge dump rather than a smudge, and SkyTruth's own attribution
  // model reads its linearity and aspect ratio. Collapsing that to a dot would
  // throw away the part a reader can actually judge. Allen Coral's benthic and
  // geomorphic zones are polygons for the same reason — a reef zone has an
  // extent and is not anywhere in particular.
  //
  // A circle layer given polygon geometry does not error. It draws nothing,
  // which reads as a source that returned no data.
  if (cfg.geometry === "polygon") {
    map.addLayer({
      id: `${cfg.id}-fill`,
      type: "fill",
      source: `${cfg.id}-live`,
      paint: {
        "fill-color": cfg.colour,
        // Lower than a point layer's. These overlap each other and the basemap
        // needs to stay readable underneath — a slick over a coastline is the
        // thing you want to see the relationship of.
        "fill-opacity": .38,
      },
    });
    // The outline separately, because at low zoom a slick is a few pixels wide
    // and a fill alone disappears. The line keeps it findable when the fill is
    // sub-pixel.
    map.addLayer({
      id: `${cfg.id}-line`,
      type: "line",
      source: `${cfg.id}-live`,
      paint: {
        "line-color": cfg.colour,
        "line-width": ["interpolate", ["linear"], ["zoom"], 3, .7, 10, 1.6],
        "line-opacity": .85,
      },
    });
    bindPopup(`${cfg.id}-fill`);
    applyVisibility(cfg.id);
    return;
  }

  map.addLayer({
    id: `${cfg.id}-pt`,
    type: "circle",
    source: `${cfg.id}-live`,
    paint: {
      "circle-color": cfg.colour,
      "circle-opacity": .75,
      "circle-stroke-color": "#17150F",
      "circle-stroke-width": .6,
      // A location layer draws every point the same size. Encoding magnitude
      // here would say "this farm matters more", which is not what the layer
      // is for, and with 37.7 million points it would read as noise regardless.
      "circle-radius": cfg.uniformRadius
        ? ["interpolate", ["linear"], ["zoom"], 8, 2.5, 14, 4.5]
        : ["interpolate", ["linear"], ["zoom"], 8, 3.5, 14, 7],
    },
  });
  bindPopup(`${cfg.id}-pt`);
  applyVisibility(cfg.id);
}

// Place names go on top of the data rather than under it. Added last, after
// every other layer exists, because MapLibre draws in insertion order and a
// beforeId naming a layer that has not been added yet throws.
function addLabelsOnTop() {
  if (map.getLayer("labels")) return;
  // Skipped rather than thrown if the style did not supply the source. A
  // missing label layer costs place names; a throw here costs every layer
  // added after it, which is a far worse failure for one cosmetic overlay.
  if (typeof map.getSource === "function" && !map.getSource("labels")) return;
  map.addLayer({
    id: "labels", type: "raster", source: "labels",
    paint: { "raster-opacity": .92 },
  });
}

// FAO serves WMTS directly with permissive CORS, so these need no Worker —
// unlike the keyed sources, there is nothing to hide and nothing to proxy.
//
// Note the axes: FAO's template puts TileCol={y} and TileRow={x}, which is the
// reverse of the usual convention. That is what their catalogue publishes, and
// swapping them to "fix" it returns the wrong tiles.
function addWmtsLayer(cfg) {
  map.addSource(`${cfg.id}-tiles`, {
    type: "raster",
    tiles: ["https://data.apps.fao.org/map/wmts/wmts" +
            `?layer=${encodeURIComponent(cfg.wmtsLayer)}` +
            "&tilematrixset=EPSG%3A3857&Service=WMTS&request=GetTile" +
            "&Version=1.0.0&Format=image/png" +
            "&TileMatrix={z}&TileCol={y}&TileRow={x}&layertype=Image"],
    tileSize: 256,
    maxzoom: 10,
    attribution: cfg.attribution || "",
  });
  map.addLayer({
    id: `${cfg.id}-raster`,
    type: "raster",
    source: `${cfg.id}-tiles`,
    paint: { "raster-opacity": 0.8 },
  });
  setLayerState(cfg.id, cfg.unit);
  applyVisibility(cfg.id);
}

/* ---------- raster tile layers, via the Worker ---------- */

// A continuous field rather than a set of located things. There is nothing to
// cluster and nothing to debounce: MapLibre asks for the tiles the viewport
// covers, the Worker caches them at the edge, and panning back over ground
// already seen costs nothing.
function addTileLayer(cfg) {
  map.addSource(`${cfg.id}-tiles`, {
    type: "raster",
    // tilePath lets several layers share one Worker route, distinguished by
    // tileQuery — the three alert layers are the same endpoint with different
    // datasets and windows behind it.
    tiles: [`${WORKER}/${cfg.tilePath || cfg.id + "_tile"}/{z}/{x}/{y}` +
            (cfg.tileQuery ? `?${cfg.tileQuery}` : "")],
    tileSize: 256,
    // Past its maxzoom MapLibre scales the last tiles up rather than asking for
    // tiles the source does not serve — which would be a 400 on every one.
    maxzoom: cfg.tileMaxZoom || 12,
    attribution: cfg.attribution || "",
  });

  // Added here, synchronously, while the pmtiles layers are still awaiting
  // their HEAD requests — so the circles land on top of the heatmap rather than
  // under it. beforeId is not used because the layers it would name may not
  // exist yet, and MapLibre throws on a beforeId that is missing.
  map.addLayer({
    id: `${cfg.id}-raster`,
    type: "raster",
    source: `${cfg.id}-tiles`,
    paint: {
      // The ramp's own lowest step is fully transparent, so empty ocean stays
      // empty; this only softens the painted cells against the basemap.
      "raster-opacity": 0.85,
    },
  });

  setLayerState(cfg.id, cfg.unit);
  applyVisibility(cfg.id);
}

/* ---------- shared ---------- */

function bindPopup(layerId) {
  map.on("click", layerId, (e) => {
    const p = e.features[0].properties;
    const count = Number(p._count || 1);
    // Some layers genuinely have no magnitude — a head office, a trade body,
    // a facility record with no release figure. Rather than announce the
    // absence, show what the source does know.
    const detail = Object.entries(p)
      .filter(([k, v]) => k.startsWith("x_") && v !== null && v !== "" &&
                          k !== "x_precision")
      .slice(0, 6)
      .map(([k, v]) => `${k.slice(2).replace(/_/g, " ")}: ${v}`)
      .join("<br>");
    const value = p.value != null && p.value !== ""
      ? `${Number(p.value).toLocaleString()} ${p.unit || ""}`
      : (p.unit || "");

    // A merged feature inherits ONE member's name, operator, country, status
    // and link. The summed value is real; those fields are not facts about the
    // cluster, so they are withheld rather than shown with a caveat.
    const html = count > 1
      ? `<b>${count.toLocaleString()} sites</b>${value}` +
        `<div class="meta">Combined total for this area. Zoom in to see the ` +
        `individual sites and their details.</div>` +
        `<div class="meta">${p.source}<br>${p.licence || ""}</div>`
      : `<b>${p.name || "Unnamed"}</b>${value}` +
        (detail ? `<div class="meta">${detail}</div>` : "") +
        (p.x_precision === "country"
          ? `<div class="meta" style="color:#8F4E40">Plotted at the country ` +
            `centroid — the source has no site coordinate for this one.</div>`
          : p.x_precision === "admin"
          ? `<div class="meta" style="color:#8F4E40">Not a facility. This is an ` +
            `administrative area${p.x_asset_definition ? ` (${p.x_asset_definition})` : ""}` +
            `, plotted at its centroid — the emissions are modelled across the ` +
            `whole unit, not emitted at this point.</div>`
          : p.x_precision === "grid"
          ? `<div class="meta" style="color:#8F4E40">Not a facility. This is a ` +
            `model grid cell${p.x_grid_cell ? ` of about ${p.x_grid_cell}` : ""}` +
            `, plotted at its centre — the emissions are spread across the cell.</div>`
          : p.x_precision === "area"
          ? `<div class="meta" style="color:#8F4E40">Not a facility. This is an ` +
            `area${p.x_asset_definition ? ` (${p.x_asset_definition})` : ""} — ` +
            `paddies, fields or a reservoir — plotted at a single point.</div>`
          : p.x_precision === "segment"
          ? `<div class="meta" style="color:#8F4E40">Not a facility. This is a ` +
            `stretch of road or rail, plotted at one point along it rather than ` +
            `drawn as the line it is.</div>`
          : p.x_precision === "blurred"
          ? `<div class="meta" style="color:#8F4E40">This position has been ` +
            `deliberately coarsened by the source, to about 5 km. Burial ` +
            `locations are withheld because publishing them invites ` +
            `desecration. The mark is a neighbourhood, not a site.</div>`
          : p.x_precision === "mobile"
          ? `<div class="meta" style="color:#8F4E40">A vessel, not a site. This ` +
            `position is where it was recorded, not where it stays.</div>`
          : p.x_precision === "unknown"
          ? `<div class="meta" style="color:#8F4E40">The source gives no ` +
            `definition for what this point represents, so it is not shown as a ` +
            `facility.</div>`
          : "") +
        `<div class="meta">${p.source}${p.year ? " · " + p.year : ""}<br>${p.licence || ""}` +
        (p.url ? `<br><a href="${p.url}" target="_blank" rel="noopener">Source record</a>` : "") +
        `</div>`;

    new maplibregl.Popup({ closeButton: true, maxWidth: "280px" })
      .setLngLat(e.lngLat).setHTML(html).addTo(map);
  });
  map.on("mouseenter", layerId, () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", layerId, () => (map.getCanvas().style.cursor = ""));
}

function setLayerState(id, text) {
  const el = document.querySelector(`[data-state="${id}"]`);
  if (el) el.textContent = text;
}

// Which facet values are currently shown, per layer. Empty set means all.
// Seeded from defaultValues so a layer with 66 monthly periods opens on one of
// them rather than drawing all 66 stacked on the same point.
const facetState = new Map(
  LAYERS.filter((c) => c.facet && c.facet.defaultValues)
        .map((c) => [c.id, new Set(c.facet.defaultValues)]));

// One request in flight per layer. Global Fishing Watch tokens permit a single
// concurrent report, and panning fires a request per movement — so without
// this the map issues several at once and every one after the first is
// refused with 429.
const inFlight = new Map();

// Panning emits a burst of moveend events. Waiting for the movement to settle
// turns a drag across a country into one request instead of a dozen.
const SETTLE_MS = 600;
let settleTimer = null;
function afterMovement(fn) {
  clearTimeout(settleTimer);
  settleTimer = setTimeout(fn, SETTLE_MS);
}

// Desired visibility per layer, applied whenever its layers exist.
// Seeded from the layer configs so an `off` layer is hidden the moment it is
// added, not after the panel is built.
const visibility = new Map(LAYERS.filter((c) => c.off).map((c) => [c.id, "none"]));

function applyVisibility(id) {
  const vis = visibility.get(id) || "visible";
  [`${id}-agg`, `${id}-pt`, `${id}-fill`, `${id}-line`, `${id}-raster`].forEach((l) => {
    if (map.getLayer(l)) map.setLayoutProperty(l, "visibility", vis);
  });
}

function applyFacet(cfg) {
  const chosen = facetState.get(cfg.id);
  const picked = (!chosen || chosen.size === 0)
    ? null
    : ["in", ["get", cfg.facet.property], ["literal", [...chosen]]];
  // `where` defines what the layer IS (climate_trace_cafo is one definition out
  // of a shared archive). The facet narrows within that. Replacing rather than
  // combining would silently turn the CAFO layer back into every source.
  const filter = cfg.where
    ? (picked ? ["all", cfg.where, picked] : cfg.where)
    : picked;
  // Same four ids applyVisibility walks. -fill and -line are here because a
  // polygon layer can carry `where` or a facet just as a point layer can, and
  // a filter that reaches only the circle layers would leave the polygons
  // showing everything while the panel says otherwise — the silent-disagreement
  // failure this function's `where` guard already exists to prevent.
  [`${cfg.id}-agg`, `${cfg.id}-pt`, `${cfg.id}-fill`, `${cfg.id}-line`].forEach((l) => {
    if (map.getLayer(l)) map.setFilter(l, filter);
  });
  const el = document.querySelector(`[data-state="${cfg.id}"]`);
  if (el) {
    el.textContent = (!chosen || chosen.size === 0)
      ? cfg.unit
      : `${cfg.unit} · ${chosen.size} of ${cfg.facet.values.length} ${cfg.facet.label}s`;
  }
}

function facetRow(cfg) {
  const box = document.createElement("div");
  box.className = "facet";
  box.dataset.for = cfg.id;
  box.innerHTML = cfg.facet.values
    .map((v) => `<button class="chip" data-facet="${cfg.id}" data-value="${v}">${v}</button>`)
    .join("") + `<button class="chip reset" data-facet="${cfg.id}" data-value="">all</button>`;
  return box;
}

// Build the parent row and its nested children.
function groupRows(group) {
  const wrap = document.createElement("div");
  wrap.className = "group";
  const parent = document.createElement("label");
  parent.className = "layer";
  parent.innerHTML =
    `<input type="checkbox" data-group="${group.id}">` +
    `<span class="swatch" style="background:${group.children[0].colour}"></span>` +
    `<span class="body"><span class="nm">${group.name}</span>` +
    `<span class="un" data-state="${group.id}">` +
    `${group.children.length} year archives, loaded on demand</span></span>`;
  wrap.appendChild(parent);

  group.children.forEach((child) => {
    const row = document.createElement("label");
    row.className = "layer child";
    row.innerHTML =
      `<input type="checkbox" data-layer="${child.id}">` +
      `<span class="swatch" style="background:${child.colour}"></span>` +
      `<span class="body"><span class="nm">${child.name}</span>` +
      `<span class="un" data-state="${child.id}">not loaded</span></span>`;
    wrap.appendChild(row);
  });
  return wrap;
}

// none / some / all. A checkbox that reads "on" while two of six children are
// showing is the same failure as a cluster popup inheriting one member's name:
// the control states something the map does not show. `indeterminate` is the
// only honest rendering of partial, so it is used rather than approximated.
function syncGroupBox(box, group) {
  for (const g of (group ? [group] : GROUPS)) {
    const parent = box.querySelector(`[data-group="${g.id}"]`);
    if (!parent) continue;
    const on = g.children.filter(
      (c) => (visibility.get(c.id) || "none") === "visible").length;
    parent.checked = on === g.children.length && on > 0;
    parent.indeterminate = on > 0 && on < g.children.length;
    const el = box.querySelector(`[data-state="${g.id}"]`);
    if (el) {
      el.textContent = on === 0
        ? `${g.children.length} archives, loaded on demand`
        : `${on} of ${g.children.length} showing`;
    }
  }
}

// Every group, in panel order. A child id is looked up across all of them, so
// adding a group needs no change to the toggle handler.
const GROUPS = [CT_SECTORS, CT_HISTORY];
function childById(id) {
  for (const g of GROUPS) {
    const hit = g.children.find((c) => c.id === id);
    if (hit) return hit;
  }
  return null;
}

// Create a lazy layer once, on first tick. Repeat ticks are a no-op, and a
// failure marks the row rather than throwing into the change handler, where an
// unhandled rejection would leave the box ticked and nothing on the map.
const created = new Set();
function ensureLayer(cfg) {
  if (created.has(cfg.id)) return;
  created.add(cfg.id);
  setLayerState(cfg.id, "loading\u2026");
  addPmtilesLayer(cfg)
    .then(() => {
      const box = document.getElementById("layers");
      if (cfg.facet) {
        const existing = box.querySelector(`.facet[data-for="${cfg.id}"]`);
        if (!existing && cfg.facet.values.length) {
          const row = box.querySelector(`[data-layer="${cfg.id}"]`).closest("label");
          row.after(facetRow(cfg));
        }
      }
      applyVisibility(cfg.id);
    })
    .catch((e) => {
      // Let it be retried: a year that failed once because R2 was slow should
      // not be permanently dead for the rest of the session.
      created.delete(cfg.id);
      setLayerState(cfg.id, `failed (${e.message})`);
    });
}

// Replace a facet row in place once its values are known. Built before the
// archive answers, so the first render can be empty and this fills it.
function refreshFacetRow(cfg) {
  const box = document.getElementById("layers");
  if (!box) return;
  const old = box.querySelector(`.facet[data-for="${cfg.id}"]`);
  const fresh = facetRow(cfg);
  if (old) old.replaceWith(fresh);
  else {
    const cb = box.querySelector(`[data-layer="${cfg.id}"]`);
    if (cb) cb.closest("label").after(fresh);
  }
}

function buildPanel() {
  const box = document.getElementById("layers");

  // Only built layers appear. Greyed-out placeholders for sources that have no
  // harvester yet read as breakage — three separate times they were reported as
  // "layers not working" — so unbuilt sources are named once at the bottom
  // instead of sitting in the list looking broken.
  LAYERS.filter((c) => c.ready).forEach((cfg) => {
    const row = document.createElement("label");
    row.className = "layer";
    row.innerHTML =
      // Layers marked off start unticked. The alert rasters are: a raster that
      // fails to render covers the whole viewport in a flat wash, which is what
      // hid every other layer. Off by default means one broken upstream layer
      // cannot take the map down with it.
      `<input type="checkbox"${cfg.off ? "" : " checked"} data-layer="${cfg.id}">` +
      `<span class="swatch" style="background:${cfg.colour}"></span>` +
      `<span class="body"><span class="nm">${cfg.name}</span>` +
      `<span class="un" data-state="${cfg.id}">${cfg.unit}</span></span>`;
    box.appendChild(row);
    if (cfg.facet) box.appendChild(facetRow(cfg));
  });

  // The group renders only if it has children. With no year archives on R2 the
  // parent is absent entirely rather than an empty disclosure that opens onto
  // nothing.
  GROUPS.filter((g) => g.children.length)
        .forEach((g) => box.appendChild(groupRows(g)));

  const pending = LAYERS.filter((c) => !c.ready);
  if (pending.length) {
    const el = document.createElement("p");
    el.className = "pending-note";
    el.textContent = `${pending.length} more sources in progress: ` +
      pending.map((c) => c.name).join(", ") + ".";
    box.appendChild(el);
  }

  box.addEventListener("click", (e) => {
    const btn = e.target.closest(".chip");
    if (!btn) return;
    const cfg = LAYERS.find((l) => l.id === btn.dataset.facet);
    if (!cfg) return;
    const chosen = facetState.get(cfg.id) || new Set();
    if (btn.dataset.value === "") {
      chosen.clear();
    } else {
      chosen.has(btn.dataset.value)
        ? chosen.delete(btn.dataset.value)
        : chosen.add(btn.dataset.value);
    }
    facetState.set(cfg.id, chosen);
    btn.closest(".facet").querySelectorAll(".chip").forEach((c) => {
      c.classList.toggle("on", c.dataset.value !== "" && chosen.has(c.dataset.value));
    });
    applyFacet(cfg);
  });

  box.addEventListener("change", (e) => {
    // The group parent ticks and unticks every child, then falls through to
    // the per-child handling below by dispatching nothing — each child's state
    // is set directly here so one click does not fire six change events.
    if (e.target.dataset.group) {
      const group = GROUPS.find((g) => g.id === e.target.dataset.group);
      if (!group) return;
      const on = e.target.checked;
      group.children.forEach((child) => {
        const cb = box.querySelector(`[data-layer="${child.id}"]`);
        if (cb) cb.checked = on;
        visibility.set(child.id, on ? "visible" : "none");
        if (on) ensureLayer(child);
        applyVisibility(child.id);
      });
      syncGroupBox(box, group);
      return;
    }

    const id = e.target.dataset.layer;
    if (!id) return;
    // Remembered, because layers load asynchronously: a toggle flipped before
    // its archive arrives would otherwise be lost and the layer would appear.
    visibility.set(id, e.target.checked ? "visible" : "none");
    // Lazy layers do not exist until now. Created on the first tick, so an
    // unopened year costs no header fetch, no index read and no tile request.
    if (e.target.checked) {
      const child = childById(id);
      if (child) ensureLayer(child);
    }
    applyVisibility(id);
    syncGroupBox(box);
  });

  document.getElementById("note").textContent =
    `Below zoom ${CLUSTER_MAXZOOM} every layer shows summed totals. Zoom past it and ` +
    `individual assets load for the visible area only. Units differ by layer and ` +
    `are never combined into a single figure.`;
}

function updateZoomState() {
  const z = map.getZoom();
  // The live layers need z8+, and "zoom in" is ambiguous without a number —
  // z8 is closer in than it feels, roughly a large country filling the screen.
  document.getElementById("zoomstate").innerHTML = z < CLUSTER_MAXZOOM
    ? `Zoom <b>${z.toFixed(1)}</b> — wide view.`
    : `Zoom <b>${z.toFixed(1)}</b> — detail view.`;
}

// Esri and CARTO are third-party tile hosts. If one stops answering, the
// console fills but the map keeps working — worth logging once so the cause is
// findable, rather than silently showing a darker map than intended.
const badTiles = new Set();
map.on("error", (e) => {
  const src = e && e.sourceId;
  if (src && ["base", "hillshade", "labels"].includes(src) && !badTiles.has(src)) {
    badTiles.add(src);
    console.warn(`[culprits] basemap source "${src}" is failing to load tiles ` +
                 `— the map still works, but it will look wrong.`);
  }
});

map.on("load", () => {
  addLabelsOnTop();
  LAYERS.filter((c) => c.ready).forEach((cfg) => {
    try {
      if (cfg.route === "worker") addLiveLayer(cfg);
      else if (cfg.route === "tile") addTileLayer(cfg);
      else if (cfg.route === "wmts") addWmtsLayer(cfg);
      else if (cfg.route === "country") {
        // Async: without a catch a failure here becomes an unhandled rejection
        // and the layer just silently never appears.
        addCountryLayer(cfg).catch((e) => setLayerState(cfg.id, `failed (${e.message})`));
      }
      else addPmtilesLayer(cfg).catch((e) => setLayerState(cfg.id, `failed (${e.message})`));
    } catch (e) {
      setLayerState(cfg.id, `failed (${e.message})`);
    }
  });
  buildPanel();
  updateZoomState();
  LAYERS.filter((c) => c.ready && c.route === "worker").forEach(refreshLiveLayer);
});

map.on("zoom", updateZoomState);
map.on("moveend", () => {
  afterMovement(() =>
    LAYERS.filter((c) => c.ready && c.route === "worker").forEach(refreshLiveLayer)
  );
});

/* ---------- guerillamap companion ---------- */
/*
 * A second map in a frame under this one, driven from this one.
 *
 * A cross-origin iframe cannot be read: no DOM access, no pulling their layers
 * out. What it can be is DRIVEN — their app takes its whole state from the
 * query string. This is the same mechanism the conflict-feed map uses, which is
 * where the contract was read from rather than guessed.
 *
 * Rebuilding src reloads the frame and makes their app re-fetch, so the update
 * waits for the gesture to settle and is skipped when the view has not actually
 * changed. Follow can be switched off to pin their view while this one moves.
 *
 * THE OVERLAY IDS ARE THEIRS, AND VERIFIED
 * Taken from guerillamap.com/shortcuts, which publishes complete prefiltered
 * URLs. This set is their "Fossil Fuels Infrastructure" shortcut plus nuclear
 * facilities and NASA FIRMS active fires — the parts of their catalogue that
 * are about this subject. Their conflict overlays, which conflict-feed uses,
 * are deliberately not here.
 *
 * Some guerillamap layers sit behind a membership. If a layer renders empty in
 * the frame, check that before assuming the id is wrong.
 */
const GM_HOME = "https://guerillamap.com/";
const GM_GRID = "-0.35,0.5,10,10,null,null";
const GM_BASEMAP = "esri-aerial-layer";
const GM_OVERLAYS = [
  "feature_group_ppcoal", "feature_group_ppgas", "feature_group_ppoil",
  "feature_group_oilgaswells", "feature_group_refineries", "feature_group_pipelines",
  "feature_group_ppnuc", "feature_group_nuctests",
  "feature_group_FIRMS", "feature_group_borders",
].join(",");

// Their panel is wider and shorter than this map, so handing it the same centre
// puts the ground higher in their frame than in ours. Dropped south by a share
// of their own frame height — a proportion, not a fixed number of degrees, so it
// holds at every zoom. gmShift(0) turns it off.
let GM_SHIFT = 0.22;
let gmOpen = false, gmTimer = null, gmLast = "";

function gmUrl() {
  let lat = 20, lon = 10, z = 3;
  try {
    const c = map.getCenter();
    lat = c.lat; lon = c.lng;
    z = Math.max(2, Math.min(18, Math.round(map.getZoom())));
  } catch (e) { /* map not ready; the defaults stand */ }
  try {
    const f = document.getElementById("gmFrame");
    const hpx = (f && f.clientHeight) || 260;
    // Web Mercator: a pixel is (360 / 256·2^z) degrees of longitude, and that
    // many degrees of latitude narrowed by cos(lat).
    const degPerPx = (360 / (256 * Math.pow(2, z))) * Math.cos(lat * Math.PI / 180);
    lat = Math.max(-78, Math.min(82, lat - GM_SHIFT * hpx * degPerPx));
  } catch (e) { /* no frame yet; centre as-is */ }

  return GM_HOME + "?coords=" + encodeURIComponent(lat.toFixed(5) + "," + lon.toFixed(5)) +
         "&zoom=" + z +
         "&grid=" + encodeURIComponent(GM_GRID) +
         "&basemap=" + GM_BASEMAP +
         "&overlays=" + encodeURIComponent(GM_OVERLAYS);
}

window.gmShift = (v) => { if (v != null) GM_SHIFT = v; gmSync(true); return GM_SHIFT; };

function gmSync(force) {
  if (!gmOpen) return;
  const follow = document.getElementById("gmFollow");
  if (!force && !(follow && follow.checked)) return;
  const url = gmUrl();
  if (url === gmLast) return;          // same view: do not reload them for nothing
  gmLast = url;
  const f = document.getElementById("gmFrame");
  const out = document.getElementById("gmOut");
  const wait = document.getElementById("gmWait");
  if (out) out.href = url;
  if (!f) return;
  if (wait) wait.hidden = false;
  f.addEventListener("load", () => { if (wait) wait.hidden = true; }, { once: true });
  // Wait a frame: assigning src before the panel has been laid out leaves their
  // app measuring a zero-height box and drawing nothing into it.
  requestAnimationFrame(() => { f.src = url; });
}

function gmSetOpen(open) {
  const el = document.getElementById("gm");
  const canvas = document.getElementById("map");
  if (!el || !canvas) return;
  gmOpen = open;
  el.hidden = !open;
  canvas.classList.toggle("gm-open", open);
  // The container changed size, so MapLibre has to re-measure or the canvas
  // keeps the old dimensions and the mouse lands in the wrong place.
  if (typeof map.resize === "function") map.resize();
  if (open) gmSync(true);
}

function gmInit() {
  const close = document.getElementById("gmClose");
  if (close) close.addEventListener("click", () => gmSetOpen(false));
  const follow = document.getElementById("gmFollow");
  if (follow) follow.addEventListener("change", () => gmSync(true));

  // Opened from its own row in the panel rather than on by default: it is a
  // third-party frame that fetches on load, and one that fails should not be
  // the first thing a reader meets.
  const box = document.getElementById("layers");
  if (!box) return;
  const row = document.createElement("label");
  row.className = "layer";
  row.innerHTML =
    `<input type="checkbox" data-gm="1">` +
    `<span class="swatch" style="background:#6E7B84"></span>` +
    `<span class="body"><span class="nm">Guerillamap overlays</span>` +
    `<span class="un">fossil fuel and nuclear infrastructure, active fires — ` +
    `loads guerillamap.com in a frame</span></span>`;
  box.appendChild(row);
  box.addEventListener("change", (e) => {
    if (e.target && e.target.dataset && e.target.dataset.gm) gmSetOpen(e.target.checked);
  });
}

map.on("load", gmInit);
map.on("moveend", () => { clearTimeout(gmTimer); gmTimer = setTimeout(gmSync, 900); });

}  // end of the double-execution guard
