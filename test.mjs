/**
 * Map logic tests.
 *
 * The map can't be rendered here — no browser is installable in this
 * environment — but almost everything that goes wrong with a MapLibre map goes
 * wrong before a pixel is drawn: layers added before their source exists,
 * a beforeId naming a layer that isn't there, a fetch path that resolves to
 * the wrong place, popups asserting things the data doesn't support.
 *
 * So MapLibre is stubbed and app.js is run against it. The stub is strict on
 * purpose: it throws on the same things the real library throws on.
 *
 * Run: node map/test.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
}

// --- strict MapLibre stub --------------------------------------------------
class FakeMap {
  constructor() {
    this.sources = new Map();
    this.layers = [];
    this.handlers = new Map();
    this.featureState = new Map();
    this.zoom = 1.6;
    this.errors = [];
  }
  addSource(id, def) {
    if (this.sources.has(id)) throw new Error(`source "${id}" already exists`);
    this.sources.set(id, def);
  }
  getSource(id) {
    const d = this.sources.get(id);
    return d ? { ...d, setData: (data) => { d._data = data; } } : undefined;
  }
  addLayer(def, beforeId) {
    if (!this.sources.has(def.source)) {
      throw new Error(`layer "${def.id}" references missing source "${def.source}"`);
    }
    if (beforeId !== undefined && !this.layers.some((l) => l.id === beforeId)) {
      throw new Error(`beforeId "${beforeId}" does not exist`);
    }
    this.layers.push(def);
  }
  getLayer(id) { return this.layers.find((l) => l.id === id); }
  setLayoutProperty(id, k, v) {
    const l = this.getLayer(id);
    if (!l) throw new Error(`setLayoutProperty on missing layer "${id}"`);
    (l.layout ||= {})[k] = v;
  }
  setFeatureState({ source, id }, state) {
    if (!this.sources.has(source)) throw new Error(`featureState on missing source`);
    // MapLibre merges into existing state rather than replacing it. The stub
    // must too, or it hides exactly the collision this test is looking for.
    const k = `${source}:${id}`;
    this.featureState.set(k, { ...(this.featureState.get(k) || {}), ...state });
  }
  getFeatureState({ source, id }) { return this.featureState.get(`${source}:${id}`) || {}; }
  on(ev, a, b) {
    const key = b ? `${ev}:${a}` : ev;
    if (!this.handlers.has(key)) this.handlers.set(key, []);
    this.handlers.get(key).push(b || a);
  }
  fire(key, arg) { (this.handlers.get(key) || []).forEach((h) => h(arg)); }
  addControl() {}
  setFilter(id, f) {
    const l = this.getLayer(id);
    if (!l) throw new Error(`setFilter on missing layer "${id}"`);
    l.filter = f;
  }
  getZoom() { return this.zoom; }
  getBounds() {
    return { getWest: () => 10, getSouth: () => 20, getEast: () => 11, getNorth: () => 21 };
  }
  getCanvas() { return { style: {} }; }
}

let popups = [];
class FakePopup {
  constructor() { this.html = null; }
  setLngLat() { return this; }
  setHTML(h) { this.html = h; return this; }
  addTo() { popups.push(this); return this; }
}

const fetched = [];
function run({ layersReady = null, fetchImpl = null } = {}) {
  const map = new FakeMap();
  popups = []; fetched.length = 0;

  // Fresh window each run: app.js guards against executing twice, and every
  // test needs a clean slate.
  globalThis.window = {};
  const els = new Map();
  globalThis.document = {
    baseURI: "https://example.test/culprits/",
    getElementById: (id) => els.get(id) || (els.set(id, {
      innerHTML: "", textContent: "", appendChild() {},
      // Recorded rather than discarded: the layer toggles are wired to the
      // panel element, so a no-op here makes every toggle untestable.
      _listeners: {},
      addEventListener(ev, fn) { (this._listeners[ev] ||= []).push(fn); },
      fire(ev, arg) { (this._listeners[ev] || []).forEach((fn) => fn(arg)); },
      // The panel queries itself for group and layer checkboxes. Returning
      // nothing is the honest stub answer — no rows are rendered here — but it
      // has to be a function, or the group code throws where a browser would
      // simply find no match.
      querySelector: () => null, querySelectorAll: () => [],
      dataset: {}, after() {}, replaceWith() {}, closest: () => null,
    }), els.get(id)),
    querySelector: () => ({ textContent: "" }),
    // Closer to a real element than it was: the layer panel now builds nested
    // group rows, reads data-* attributes and inserts facet rows after a
    // checkbox, so a stub with only className and innerHTML made app.js look
    // broken when it was the harness that was thin.
    createElement: () => ({
      className: "", innerHTML: "", dataset: {},
      appendChild() {}, after() {}, replaceWith() {},
      closest: () => null, querySelector: () => null, querySelectorAll: () => [],
    }),
    addEventListener() {},
  };
  globalThis.maplibregl = {
    Map: function () { return map; },
    NavigationControl: function () {}, ScaleControl: function () {},
    Popup: FakePopup,
    addProtocol() {},
  };
  globalThis.pmtiles = { Protocol: function () { return { tile: () => {} }; } };
  globalThis.document.baseURI = "https://example.test/culprits/";
  globalThis.fetch = fetchImpl || (async (u) => {
    fetched.push(u);
    return { ok: true, status: 200, json: async () => ({}) };
  });

  let src = fs.readFileSync(path.join(HERE, "app.js"), "utf8");
  if (layersReady) src = src.replace(/ready:\s*true/g, "ready:false")
                           .replace(new RegExp(`(id:"${layersReady}"[^}]*?)ready:false`), "$1ready:true");
  new Function(src)();
  return { map, els };
}

console.log("\nmap wiring");

// --- layers are added against sources that exist ---------------------------
{
  const { map } = run();
  let err = null;
  try { map.fire("load"); await new Promise((r) => setTimeout(r, 5)); }
  catch (e) { err = e; }
  check("load adds layers without error", err === null, err && err.message);
  check("point source registered", map.sources.has("carbon_bombs-src"));
  check("aggregate + detail layers both added",
        !!map.getLayer("carbon_bombs-agg") && !!map.getLayer("carbon_bombs-pt"));
  check("tile URL is absolute",
        String(map.sources.get("carbon_bombs-src").url).startsWith("pmtiles://https://"),
        String(map.sources.get("carbon_bombs-src").url));
}

// --- the beforeId race -----------------------------------------------------
{
  // Country layers are added asynchronously and reference a point layer by id.
  // If no point layer is ready, that id doesn't exist and MapLibre throws.
  const { map } = run({ layersReady: "land_matrix" });
  let err = null;
  process.once("unhandledRejection", (e) => { err = e; });
  try {
    map.fire("load");
    await new Promise((r) => setTimeout(r, 5));   // let the async layer settle
  } catch (e) { err = e; }
  check("country layer alone does not throw on beforeId",
        err === null, err && err.message);
  check("country fill layer was actually added",
        !!map.getLayer("land_matrix-fill"));
}

// --- zoom threshold matches the tiling -------------------------------------
{
  const { map } = run();
  map.fire("load");
  await new Promise((r) => setTimeout(r, 5));
  const agg = map.getLayer("carbon_bombs-agg");
  const pt = map.getLayer("carbon_bombs-pt");
  check("aggregate layer stops at the cluster threshold", agg.maxzoom === 8);
  check("detail layer starts at the cluster threshold", pt.minzoom === 8);
  check("radius reads _count, not point_count",
        JSON.stringify(agg.paint["circle-radius"]).includes("_count"));
}

// --- popups: a cluster must not inherit a member's identity ----------------
{
  const { map } = run();
  map.fire("load");
  await new Promise((r) => setTimeout(r, 5));

  map.fire("click:carbon_bombs-pt", {
    lngLat: [0, 0],
    features: [{ properties: {
      _count: 425, value: 1182.3, unit: "Gt", name: "Gething Coal Mine",
      x_country: "Canada", x_operator: "CKD Mines", source: "carbon_bombs",
      url: "https://example.invalid/gething",
    } }],
  });
  const clusterHtml = popups.at(-1).html;
  check("cluster popup states the count", /425/.test(clusterHtml));
  check("cluster popup withholds the inherited name",
        !/Gething/.test(clusterHtml), clusterHtml.slice(0, 120));
  check("cluster popup withholds the inherited operator",
        !/CKD Mines/.test(clusterHtml));
  check("cluster popup withholds the inherited link",
        !/example\.invalid/.test(clusterHtml));

  map.fire("click:carbon_bombs-pt", {
    lngLat: [0, 0],
    features: [{ properties: {
      _count: 1, value: 1.6, unit: "Gt", name: "Agha Jari",
      source: "carbon_bombs", url: "https://example.invalid/agha",
    } }],
  });
  const singleHtml = popups.at(-1).html;
  check("single-site popup names the site", /Agha Jari/.test(singleHtml));
  check("single-site popup links the source record",
        /example\.invalid/.test(singleHtml));
}

// --- centroid honesty carried through --------------------------------------
{
  const { map } = run();
  map.fire("load");
  await new Promise((r) => setTimeout(r, 5));
  map.fire("click:carbon_bombs-pt", {
    lngLat: [0, 0],
    features: [{ properties: { _count: 1, value: 5, name: "X", x_precision: "country" } }],
  });
  check("centroid features say so", /centroid/i.test(popups.at(-1).html));
}

// --- country layer fetch path ----------------------------------------------
{
  const { map } = run();
  map.fire("load");
  await new Promise((r) => setTimeout(r, 5));
  const p = fetched.find((u) => String(u).includes("land_matrix"));
  check("country data fetched", !!p, `fetched: ${JSON.stringify(fetched)}`);
  if (p) check("country path has no '/../' segment", !String(p).includes("/../"),
               String(p));
}

// --- live layers only query past the threshold -----------------------------
{
  const { map } = run();
  map.fire("load");
  await new Promise((r) => setTimeout(r, 5));
  fetched.length = 0;
  map.zoom = 3;
  map.fire("moveend");
  await new Promise((r) => setTimeout(r, 0));
  // At world zoom the viewport is far wider than any source can answer for,
  // so the request is skipped rather than sent and refused.
  check("no worker call when the viewport is wider than the source allows",
        !fetched.some((u) => String(u).includes("/v1/")), JSON.stringify(fetched));
}

// --- a missing archive must say so ----------------------------------------
{
  const { map, els } = run({
    fetchImpl: async (u, o) => (String(u).endsWith(".pmtiles")
      ? { ok: false, status: 404 }
      : { ok: true, status: 200, json: async () => ({}) }),
  });
  map.fire("load");
  await new Promise((r) => setTimeout(r, 5));
  check("missing archive does not register a source",
        !map.sources.has("carbon_bombs-src"));
  check("missing archive does not throw", true);
}

// --- two country layers must not overwrite each other ---------------------
{
  const { map } = run({
    fetchImpl: async (u) => {
      const id = String(u).includes("land_matrix") ? "land_matrix" : "owid_co2";
      if (String(u).endsWith(".pmtiles")) return { ok: false, status: 404 };
      return { ok: true, status: 200, json: async () => ({
        USA: { value: id === "land_matrix" ? 111 : 999, unit: id, name: "USA" },
      }) };
    },
  });
  map.fire("load");
  await new Promise((r) => setTimeout(r, 10));
  const st = map.getFeatureState({ source: "boundaries", id: "USA" });
  check("each country layer keeps its own value",
        st.v_land_matrix === 111 && st.v_owid_co2 === 999,
        JSON.stringify(st));
}

// --- heavy-tailed data must stay visible ----------------------------------
{
  const { map } = run({
    fetchImpl: async (u) => {
      if (String(u).endsWith(".pmtiles")) return { ok: false, status: 404 };
      return { ok: true, status: 200, json: async () => ({
        CHN: { value: 12289, unit: "Mt" },   // the outlier
        KEN: { value: 21.2, unit: "Mt" },    // a median-ish country
      }) };
    },
  });
  map.fire("load");
  await new Promise((r) => setTimeout(r, 10));
  const fill = map.getLayer("owid_co2-fill");
  const expr = JSON.stringify(fill.paint["fill-opacity"]);
  check("choropleth uses a log scale", /log10/.test(expr), expr.slice(0, 90));
  check("small values keep a visible floor", /0\.12/.test(expr));
  check("no-data countries stay transparent", expr.includes('"case"'));
}

// --- fuel filtering happens in the map, not the harvester -----------------
{
  const { map } = run();
  map.fire("load");
  await new Promise((r) => setTimeout(r, 10));
  const pt = map.getLayer("power_plants-pt");
  check("no filter is applied by default", !pt.filter,
        JSON.stringify(pt && pt.filter));
  const src = fs.readFileSync(path.join(HERE, "app.js"), "utf8");
  check("power_plants declares a fuel facet",
        /facet:\s*\{[^}]*property:\s*"x_fuel"/.test(src));
  check("the facet lists non-fossil fuels too — nothing is hidden by default",
        /"Solar"/.test(src) && /"Wind"/.test(src) && /"Hydro"/.test(src));
  check("filtering is wired to setFilter, not to the harvester",
        /map\.setFilter\(/.test(src) && !/FUELS/.test(
          fs.readFileSync(path.join(HERE, "..", "pipeline", "sources", "power_plants.py"), "utf8")));
}

// --- unbuilt sources must not look broken ---------------------------------
{
  const src = fs.readFileSync(path.join(HERE, "app.js"), "utf8");
  check("only ready layers get a row",
        /LAYERS\.filter\(\(c\) => c\.ready\)\.forEach/.test(src));
  check("unbuilt sources are named once, not listed as disabled rows",
        /pending-note/.test(src) && !/disabled data-layer/.test(src));
}

// --- worker layers must explain why they are empty ------------------------
{
  const src = fs.readFileSync(path.join(HERE, "app.js"), "utf8");
  check("a viewport too wide for a source says so rather than sitting empty",
        /area too wide for this source/.test(src));
  check("worker errors surface the Worker's own message, not a bare status",
        /\(await r\.json\(\)\)\.error/.test(src));
}

// --- running twice must not duplicate the layers --------------------------
{
  const { map } = run();
  map.fire("load");
  await new Promise((r) => setTimeout(r, 10));
  const before = map.layers.length;

  // Simulate index.html carrying both an inline copy and <script src>.
  const src = fs.readFileSync(path.join(HERE, "app.js"), "utf8");
  new Function(src)();
  await new Promise((r) => setTimeout(r, 10));
  check("a second execution adds no layers", map.layers.length === before,
        `${before} -> ${map.layers.length}`);
}

// --- live layers are not gated on a fixed zoom ----------------------------
{
  const src = fs.readFileSync(path.join(HERE, "app.js"), "utf8");
  check("no fixed zoom gate on live layers",
        !/getZoom\(\) < CLUSTER_MAXZOOM/.test(src));
  check("each live source declares its own area cap",
        /maxAreaDeg2/.test(src));
  check("live point layers have no minzoom",
        !/source: `\$\{cfg\.id\}-live`,\s*\n\s*minzoom/.test(src));
}

// --- live layers must not issue concurrent requests -----------------------
{
  const src = fs.readFileSync(path.join(HERE, "app.js"), "utf8");
  check("one request in flight per layer", /inFlight/.test(src));
  check("movement is allowed to settle before querying", /SETTLE_MS/.test(src));
  check("a 429 backs off and retries rather than giving up",
        /concurrent/.test(src) && /setTimeout\(\(\) => refreshLiveLayer/.test(src));
}

// --- fishing is a tile layer, not a per-viewport query ---------------------
{
  const { map, els } = run();
  map.fire("load");
  await new Promise((r) => setTimeout(r, 10));

  const src = map.sources.get("fishing-tiles");
  check("fishing registers a raster tile source", Boolean(src) && src.type === "raster",
        JSON.stringify(src));
  check("fishing tiles are addressed by z/x/y, not by bbox",
        /\/fishing_tile\/\{z\}\/\{x\}\/\{y\}/.test(src.tiles[0]) &&
        !/bbox/.test(src.tiles[0]), src.tiles[0]);
  check("fishing stops at the zoom GFW serves rather than requesting 400s",
        src.maxzoom === 12, String(src.maxzoom));
  // Required by GFW's terms of use, not decoration.
  check("the layer carries GFW attribution",
        /Powered by Global Fishing Watch/.test(src.attribution || ""), src.attribution);
  check("a raster layer is drawn from it", Boolean(map.getLayer("fishing-raster")));
  check("no geojson source is left behind for fishing", !map.sources.has("fishing-live"));

  // The whole point of the change: panning must not queue a report.
  fetched.length = 0;
  map.zoom = 9;
  map.fire("moveend");
  await new Promise((r) => setTimeout(r, 700));
  check("panning issues no /v1/fishing report request",
        !fetched.some((u) => /\/v1\/fishing(\?|$)/.test(String(u))),
        JSON.stringify(fetched));

  // The toggle must still reach it, which needs the -raster id in the list.
  els.get("layers").fire("change",
    { target: { dataset: { layer: "fishing" }, checked: false } });
  check("the layer toggle hides the raster",
        map.getLayer("fishing-raster").layout?.visibility === "none",
        JSON.stringify(map.getLayer("fishing-raster").layout));
}

// --- the report endpoint's limit is written down, not just worked around ---
{
  const src = fs.readFileSync(path.join(HERE, "app.js"), "utf8");
  check("app.js records why /report could not serve a public page",
        /report per account/i.test(src), "the reason is not stated in app.js");
}

// --- blurred positions must never draw as located sites --------------------
//
// This is regression cover for a bug that shipped in the remains harvester and
// was caught only by running it: the source tags blurred burial positions
// `geo: "coarsened"`, the mapping did not know the word, and 2,580 records
// deliberately degraded to ~5 km would have drawn as solid, precise graves.
// The map is the last place that can catch it, so the precision value has to
// be in the hollow list AND the popup has to say what happened.
{
  const { map } = run();
  map.fire("load");
  await new Promise((r) => setTimeout(r, 5));
  map.fire("click:carbon_bombs-pt", {
    lngLat: [0, 0],
    features: [{ properties: { _count: 1, name: "A permit", x_precision: "blurred" } }],
  });
  const html = popups.at(-1).html;
  check("blurred features say the position was coarsened", /coarsen/i.test(html), html);
  check("blurred features do not read as a located site",
        !/Plotted at the country centroid/.test(html));
}

// Every precision value any harvester emits must appear in the hollow list, or
// it silently renders solid. Listing them here means adding a new one to a
// harvester without adding it to the map fails a test rather than publishing a
// false position.
{
  const src = fs.readFileSync(path.join(HERE, "app.js"), "utf8");
  const EMITTED = ["country", "admin", "grid", "area", "segment", "mobile",
                   "blurred", "unknown"];
  const lists = src.match(/\[\s*"country",[^\]]*\]/g) || [];
  check("the hollow-precision list is used in every paint property",
        lists.length === 3, `found ${lists.length}`);
  for (const v of EMITTED) {
    check(`precision "${v}" renders hollow everywhere`,
          lists.length === 3 && lists.every((l) => l.includes(`"${v}"`)));
  }
}

// --- the guerillamap frame is scoped to this map's subject -----------------
{
  const src = fs.readFileSync(path.join(HERE, "app.js"), "utf8");
  const set = (src.match(/const GM_OVERLAYS = \[([\s\S]*?)\]/) || [])[1] || "";
  check("guerillamap overlays include fossil fuel infrastructure",
        /ppcoal/.test(set) && /pipelines/.test(set) && /refineries/.test(set));
  // conflict-feed drives the same frame with a conflict overlay set. Sharing the
  // mechanism must not mean inheriting the subject.
  check("guerillamap overlays carry none of conflict-feed's conflict layers",
        !/geoNews|conflicts|losses|terror|uyghurs|migration_routes/.test(set), set);
  check("the frame starts closed",
        /let gmOpen = false/.test(src), "a third-party frame should not load unasked");
  check("toggling the frame re-measures the map canvas",
        /gmSetOpen[\s\S]{0,600}map\.resize/.test(src),
        "the container changes height, so the canvas must be re-measured");
}

// --- polygon sources must not be drawn as circles --------------------------
//
// A circle layer handed polygon geometry does not throw. It draws nothing, and
// an empty layer is indistinguishable from a source that returned no data — so
// this is checked here rather than discovered on the map.
{
  const src = fs.readFileSync(path.join(HERE, "app.js"), "utf8");
  const branch = (src.match(/if \(cfg\.geometry === "polygon"\)[\s\S]*?\n  }/) || [])[0] || "";
  check("addLiveLayer has a polygon branch", branch.length > 0);
  check("the polygon branch draws a fill", /type: "fill"/.test(branch));
  check("the polygon branch draws an outline too", /type: "line"/.test(branch),
        "a sub-pixel fill at low zoom disappears without one");
  check("the polygon branch draws no circle", !/type: "circle"/.test(branch));
  check("the polygon branch returns before the circle layer",
        /return;\n  }/.test(branch), "otherwise both are added to one source");

  // applyVisibility toggles a fixed list of layer id suffixes. A polygon layer
  // whose suffixes are missing from it cannot be switched off.
  const vis = (src.match(/function applyVisibility[\s\S]*?\n}/) || [])[0] || "";
  for (const sfx of ["-fill", "-line"]) {
    check(`applyVisibility reaches ${sfx} layers`, vis.includes(`${sfx}\``) || vis.includes(sfx));
  }
}

// --- filters and visibility must cover the same layers ---------------------
{
  const src = fs.readFileSync(path.join(HERE, "app.js"), "utf8");
  const facet = (src.match(/function applyFacet[\s\S]*?\n}/) || [])[0] || "";
  for (const sfx of ["-agg", "-pt", "-fill", "-line"]) {
    check(`applyFacet filters ${sfx} layers`, facet.includes(`${sfx}\``), sfx);
  }
  // A facet must narrow what `where` selects, never replace it: replacing would
  // turn climate_trace_cafo back into every Climate TRACE source on first click.
  check("a facet is ANDed with the layer's `where`, not substituted for it",
        /\["all", cfg\.where, picked\]/.test(facet));
}

// --- layer groups ----------------------------------------------------------
{
  const src = fs.readFileSync(path.join(HERE, "app.js"), "utf8");

  // With no year archives on R2 the group must not render at all. An empty
  // disclosure, or rows that 404 on tick, read as a broken map.
  check("a group renders only when it has children",
        /GROUPS\.filter\(\(g\) => g\.children\.length\)/.test(src));
  // Two groups now share one set of functions. A child id must resolve across
  // all of them, or ticking a sector would look up only the history years and
  // silently create nothing.
  check("child lookup spans every group", /function childById[\s\S]*?for \(const g of GROUPS\)/.test(src));
  check("the toggle handler resolves which group was clicked",
        /GROUPS\.find\(\(g\) => g\.id === e\.target\.dataset\.group\)/.test(src));

  // Lazy means lazy: nothing about a year is fetched until it is ticked.
  check("year children are marked lazy", /lazy: true/.test(src));
  const load = (src.match(/map\.on\("load"[\s\S]*?buildPanel\(\)/) || [])[0] || "";
  check("no year archive is created at load",
        !/CT_HISTORY/.test(load), "the load handler must not touch the group");

  const ensure = (src.match(/function ensureLayer[\s\S]*?\n}/) || [])[0] || "";
  check("ensureLayer creates each year only once", /created\.has/.test(ensure));
  check("a failed year can be retried", /created\.delete/.test(ensure),
        "a slow R2 response must not kill the row for the session");

  // Partial selection must not read as "all on".
  const sync = (src.match(/function syncGroupBox[\s\S]*?\n}/) || [])[0] || "";
  check("the parent reports partial selection as indeterminate",
        /indeterminate = on > 0 && on < /.test(sync));
  check("the parent is only checked when every child is on",
        /checked = on === g\.children\.length/.test(sync));

  // A year archive holds 12 months; CT_MONTHS holds 66. Using the constant
  // would offer 54 months that render nothing.
  check("year facets start empty and are learned from the archive",
        /facet: \{ property: "x_period", label: "month", values: \[\] \}/.test(src));
  const learn = (src.match(/async function learnFacetValues[\s\S]*?\n}/) || [])[0] || "";
  check("a metadata read failure leaves the declared list standing",
        /catch[\s\S]*console\.warn/.test(learn));
  check("history archives are addressed off their own base, not the repo",
        /archiveUrl \|\| `\$\{TILE_BASE\}/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
