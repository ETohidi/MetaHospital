// The World screen: hospital beds per 1,000 people for every country (World Bank, Official).
// An Equal Earth choropleth plus a sortable country table. The data year is shown everywhere;
// values more than 3 years old are hatched; countries without a value are "Unknown", never 0.
// d3 and topojson are globals from index.html. Real data arrives as ctx.data (loadRealData()).

import worldTopo from "../data/world.js";
import { html } from "./dom.js";
import { levelsPanel } from "./levels.js";
import { kpiStrip, pageHead, prov as badge, sourcesFooter } from "./page.js";

const VIEW_W = 960;
const VIEW_H = 440;
const OLD_AFTER_YEARS = 3;
const PAGE_ROWS = 25;
/** Sequential bins for beds per 1,000, light to dark (--seq-1 .. --seq-5). */
const BINS = [1, 2, 3, 5];
const BIN_LABELS = ["under 1", "1–2", "2–3", "3–5", "5 or more"];

const WB_URL = "https://data.worldbank.org/indicator/SH.MED.BEDS.ZS";
const WB_POP_URL = "https://data.worldbank.org/indicator/SP.POP.TOTL";
const NE_URL = "https://github.com/topojson/world-atlas";

// The topology carries ISO 3166-1 numeric ids; the World Bank uses ISO3 codes.
const ISO_N3 = {
  "004": "AFG", "008": "ALB", "012": "DZA", "024": "AGO", "031": "AZE", "032": "ARG", "036": "AUS", "040": "AUT",
  "044": "BHS", "050": "BGD", "051": "ARM", "056": "BEL", "064": "BTN", "068": "BOL", "070": "BIH", "072": "BWA",
  "076": "BRA", "084": "BLZ", "090": "SLB", "096": "BRN", "100": "BGR", "104": "MMR", "108": "BDI", "112": "BLR",
  "116": "KHM", "120": "CMR", "124": "CAN", "140": "CAF", "144": "LKA", "148": "TCD", "152": "CHL", "156": "CHN",
  "158": "TWN", "170": "COL", "178": "COG", "180": "COD", "188": "CRI", "191": "HRV", "192": "CUB", "196": "CYP",
  "203": "CZE", "204": "BEN", "208": "DNK", "214": "DOM", "218": "ECU", "222": "SLV", "226": "GNQ", "231": "ETH",
  "232": "ERI", "233": "EST", "238": "FLK", "242": "FJI", "246": "FIN", "250": "FRA", "260": "ATF", "262": "DJI",
  "266": "GAB", "268": "GEO", "270": "GMB", "275": "PSE", "276": "DEU", "288": "GHA", "300": "GRC", "304": "GRL",
  "320": "GTM", "324": "GIN", "328": "GUY", "332": "HTI", "340": "HND", "348": "HUN", "352": "ISL", "356": "IND",
  "360": "IDN", "364": "IRN", "368": "IRQ", "372": "IRL", "376": "ISR", "380": "ITA", "384": "CIV", "388": "JAM",
  "392": "JPN", "398": "KAZ", "400": "JOR", "404": "KEN", "408": "PRK", "410": "KOR", "414": "KWT", "417": "KGZ",
  "418": "LAO", "422": "LBN", "426": "LSO", "428": "LVA", "430": "LBR", "434": "LBY", "440": "LTU", "442": "LUX",
  "450": "MDG", "454": "MWI", "458": "MYS", "466": "MLI", "478": "MRT", "484": "MEX", "496": "MNG", "498": "MDA",
  "499": "MNE", "504": "MAR", "508": "MOZ", "512": "OMN", "516": "NAM", "524": "NPL", "528": "NLD", "540": "NCL",
  "548": "VUT", "554": "NZL", "558": "NIC", "562": "NER", "566": "NGA", "578": "NOR", "586": "PAK", "591": "PAN",
  "598": "PNG", "600": "PRY", "604": "PER", "608": "PHL", "616": "POL", "620": "PRT", "624": "GNB", "626": "TLS",
  "630": "PRI", "634": "QAT", "642": "ROU", "643": "RUS", "646": "RWA", "682": "SAU", "686": "SEN", "688": "SRB",
  "694": "SLE", "703": "SVK", "704": "VNM", "705": "SVN", "706": "SOM", "710": "ZAF", "716": "ZWE", "724": "ESP",
  "728": "SSD", "729": "SDN", "732": "ESH", "740": "SUR", "748": "SWZ", "752": "SWE", "756": "CHE", "760": "SYR",
  "762": "TJK", "764": "THA", "768": "TGO", "780": "TTO", "784": "ARE", "788": "TUN", "792": "TUR", "795": "TKM",
  "800": "UGA", "804": "UKR", "807": "MKD", "818": "EGY", "826": "GBR", "834": "TZA", "840": "USA", "854": "BFA",
  "858": "URY", "860": "UZB", "862": "VEN", "887": "YEM", "894": "ZMB",
};
// Shapes without an ISO numeric id in Natural Earth.
const ISO_BY_NAME = { Kosovo: "XKX" };

/** Reporting relationship to WHO: a footnote state, not missing data (concept 2). */
const WHO_NOTES = {
  USA: "Withdrawal from WHO took effect in January 2026; the World Bank value is unaffected.",
};

// -- data ------------------------------------------------------------------------------------
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(+v) ? +v : null);

/** Reads {value, year} from a number, a {value, year|date|asOf} object or a separate year field. */
function reading(v, fallbackYear) {
  if (v === null || v === undefined) return null;
  const value = num(typeof v === "object" ? v.value : v);
  if (value === null) return null;
  const rawYear = typeof v === "object" ? (v.year ?? v.date ?? v.asOf ?? fallbackYear) : fallbackYear;
  const year = num(String(rawYear ?? "").slice(0, 4));
  return { value, year };
}

/** The World Bank block of the real data, whatever key the loader filed it under. */
function worldBlock(data) {
  if (!data) return null;
  return data.world ?? data.worldBank ?? data.countries ?? null;
}

function countryList(block) {
  if (!block) return [];
  const list = Array.isArray(block) ? block : (block.countries ?? block.rows ?? block);
  return Array.isArray(list) ? list : Object.entries(list).map(([iso3, c]) => ({ iso3, ...c }));
}

/** One row per country: {iso3, name, beds: {value, year} | null, pop: {value, year} | null}. */
function rowsFrom(data) {
  return countryList(worldBlock(data))
    .map((c) => ({
      iso3: String(c.iso3 ?? c.id ?? c.code ?? c.countryiso3code ?? "").toUpperCase(),
      name: c.name ?? c.country ?? "",
      beds: reading(c.beds ?? c.bedsPer1000 ?? c.value, c.bedsYear ?? c.year),
      pop: reading(c.population ?? c.pop, c.populationYear),
    }))
    .filter((r) => r.iso3.length === 3 && r.name);
}

/** Provenance of the World Bank block: {source, url, licence, asOf}. */
function metaFrom(data) {
  const block = worldBlock(data);
  const m = (block && !Array.isArray(block) && (block.meta ?? block.provenance ?? block.source)) || {};
  const meta = typeof m === "object" ? m : {};
  return {
    source: meta.source ?? "World Bank WDI",
    url: meta.url ?? WB_URL,
    licence: meta.licence ?? meta.license ?? "CC BY 4.0",
    asOf: meta.asOf ?? meta.lastUpdated ?? meta.generatedAt ?? null,
  };
}

const currentYear = () => new Date().getFullYear();
const isOld = (r, now) => Boolean(r.beds && r.beds.year && now - r.beds.year > OLD_AFTER_YEARS);

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function binOf(v) {
  let i = 0;
  while (i < BINS.length && v >= BINS[i]) i++;
  return i + 1;
}

// -- formatting -------------------------------------------------------------------------------
const fmtBeds = (v) => v.toLocaleString("en-GB", { maximumFractionDigits: 2 });
const fmtInt = (v) => Math.round(v).toLocaleString("en-GB");
function fmtPop(v) {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)} bn`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e8 ? 0 : 1)} M`;
  if (v >= 1e3) return `${Math.round(v / 1e3)} k`;
  return fmtInt(v);
}
function fmtDate(iso) {
  const d = iso ? new Date(`${String(iso).slice(0, 10)}T00:00:00Z`) : null;
  if (!d || Number.isNaN(d.getTime())) return iso ? String(iso) : "";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

// -- small components ---------------------------------------------------------------------------
/** Provenance badge. kind: Official | Unknown | Illustrative | Not shown. */
/** Provenance badge (page.js). kind: "Official" | "Unknown" | "Illustrative" | "Not shown". */
function prov(kind, title = "") {
  const key = { Official: "official", Unknown: "unknown", Illustrative: "illustrative", "Not shown": "notshown" }[kind] ?? "unknown";
  return badge(key, title ? { title } : {});
}

function unknown(label = "Unknown") {
  return html`<span class="w-unknown" title="No value in the World Bank series">${label}</span>`;
}

// -- the base map (projected once) -----------------------------------------------------------------
let geo = null;

function buildGeo() {
  const { d3, topojson } = globalThis;
  const all = topojson.feature(worldTopo, worldTopo.objects.countries).features;
  const features = all.filter((f) => String(f.id) !== "010"); // no Antarctica: no beds, much area
  const projection = d3.geoEqualEarth().fitExtent(
    [
      [6, 6],
      [VIEW_W - 6, VIEW_H - 6],
    ],
    { type: "FeatureCollection", features },
  );
  const path = d3.geoPath(projection);
  if (typeof path.digits === "function") path.digits(1);
  const shapes = features.map((f) => ({
    iso3: ISO_N3[String(f.id)] ?? ISO_BY_NAME[f.properties?.name] ?? null,
    mapName: f.properties?.name ?? "",
    d: path(f),
  }));
  const sphere = path({ type: "Sphere" });
  return { shapes, sphere };
}

function libsReady() {
  const { d3, topojson } = globalThis;
  return Boolean(d3 && typeof d3.geoEqualEarth === "function" && topojson && typeof topojson.feature === "function");
}

// -- view model -----------------------------------------------------------------------------------
function model(data) {
  const now = currentYear();
  const rows = rowsFrom(data).map((r) => ({ ...r, old: isOld(r, now), note: WHO_NOTES[r.iso3] ?? "" }));
  const byIso = new Map(rows.map((r) => [r.iso3, r]));
  const withData = rows.filter((r) => r.beds);
  const old = withData.filter((r) => r.old);
  const years = withData.map((r) => r.beds.year).filter(Boolean);
  return {
    now,
    rows,
    byIso,
    meta: metaFrom(data),
    total: rows.length,
    withData: withData.length,
    median: median(withData.map((r) => r.beds.value)),
    oldCount: old.length,
    oldShare: withData.length ? old.length / withData.length : null,
    oldestYear: years.length ? Math.min(...years) : null,
    newestYear: years.length ? Math.max(...years) : null,
  };
}

// -- page sections -----------------------------------------------------------------------------------
function head(m, state) {
  const fresh =
    state === "ready" && m.total
      ? { badge: prov("Official", `${m.meta.source}, ${m.meta.licence}`), text: `World Bank WDI${m.meta.asOf ? ` · updated ${fmtDate(m.meta.asOf)}` : ""}` }
      : state === "failed"
        ? { badge: prov("Unknown"), text: "World Bank data did not load" }
        : { badge: prov("Unknown", "Loading"), text: "Loading World Bank data…" };
  return pageHead({
    level: "World",
    place: "All countries · WHO analyst",
    title: "Hospital beds per country",
    question: "How many hospital beds does each country have, and how old is that figure?",
    sees: "Country indicators only: beds per 1,000 people, latest year each country reported. No hospitals, no patients.",
    status: { text: "No live status at world level", tone: "mute", title: "No global source reports current hospital pressure" },
    fresh,
  });
}

function kpis(m, state) {
  const ready = state === "ready" && m.withData > 0;
  const val = (v) => (ready ? v : state === "failed" ? unknown() : html`<span class="w-loading">…</span>`);
  const b = ready ? prov("Official", `${m.meta.source}, ${m.meta.licence}`) : prov("Unknown");
  return kpiStrip(
    [
      {
        label: "Countries with data",
        value: val(m.withData),
        unit: ready ? `of ${m.total}` : "",
        detail: ready ? `Latest values from ${m.oldestYear} to ${m.newestYear}` : "World Bank country list",
        badge: b,
      },
      {
        label: "Median beds per 1,000",
        value: val(m.median === null ? unknown() : fmtBeds(m.median)),
        detail: "Across countries, each at its latest year",
        badge: b,
      },
      {
        label: `Data older than ${OLD_AFTER_YEARS} years`,
        value: val(m.oldShare === null ? unknown() : `${Math.round(m.oldShare * 100)}`),
        unit: ready && m.oldShare !== null ? "%" : "",
        detail: ready ? `${m.oldCount} of ${m.withData} countries, latest year before ${m.now - OLD_AFTER_YEARS}` : "Latest year per country",
        badge: b,
      },
    ],
    { busy: state === "loading" },
  );
}

function legend() {
  return html`<div class="w-legend" aria-label="Legend">
    <span class="w-legend-title">Beds per 1,000</span>
    ${BIN_LABELS.map((l, i) => html`<span><i class="w-sw w-bin-${i + 1}"></i>${l}</span>`)}
    <span><i class="w-sw w-bin-3 w-sw-old"></i>older than ${OLD_AFTER_YEARS} years</span>
    <span><i class="w-sw w-sw-unknown"></i>Unknown</span>
  </div>`;
}

function mapSvg(m, ui) {
  geo ??= buildGeo();
  const shape = (s) => {
    const r = s.iso3 ? m.byIso.get(s.iso3) : null;
    const name = r?.name || s.mapName;
    const cls = ["w-c"];
    if (r?.beds) cls.push(`w-bin-${binOf(r.beds.value)}`);
    else cls.push("w-c-unknown");
    if (s.iso3 === "DEU") cls.push("is-de");
    if (s.iso3 && s.iso3 === ui.selected) cls.push("is-sel");
    return html`<path class="${cls.join(" ")}" d="${s.d}" data-iso="${s.iso3 ?? ""}" data-name="${name}"></path>`;
  };
  const hatch = geo.shapes
    .filter((s) => s.iso3 && m.byIso.get(s.iso3)?.old)
    .map((s) => html`<path class="w-c-old" d="${s.d}"></path>`);
  const sel = geo.shapes.filter((s) => s.iso3 && (s.iso3 === ui.selected || s.iso3 === "DEU"));
  return html`<svg class="w-map" viewBox="0 0 ${VIEW_W} ${VIEW_H}" role="img"
      aria-label="World map of hospital beds per 1,000 people. Use the country table below for exact values.">
    <defs>
      <pattern id="w-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect class="w-hatch-gap" x="0" y="0" width="2" height="6"></rect>
      </pattern>
    </defs>
    <path class="w-sphere" d="${geo.sphere}"></path>
    <g class="w-shapes">${geo.shapes.map(shape)}</g>
    <g class="w-hatches" aria-hidden="true">${hatch}</g>
    <g class="w-outlines" aria-hidden="true">${sel.map(
      (s) => html`<path class="w-outline${s.iso3 === ui.selected ? " is-sel" : ""}" d="${s.d}"></path>`,
    )}</g>
  </svg>`;
}

/** The selected country under the map: value, year, population, and the way down for Germany. */
function focusCard(m, ui) {
  const r = m.byIso.get(ui.selected);
  if (!r) {
    const name = ui.selectedName || "This area";
    return html`<div class="w-focus"><b>${name}</b> ${unknown("Unknown")}<span class="w-muted">Not in the World Bank country list.</span></div>`;
  }
  const beds = r.beds
    ? html`<span class="w-focus-v">${fmtBeds(r.beds.value)}</span><span class="w-muted">beds per 1,000 in ${r.beds.year ?? "an unknown year"}</span>${
        r.old ? html`<span class="w-old-tag">older than ${OLD_AFTER_YEARS} years</span>` : ""
      }${prov("Official", `World Bank SH.MED.BEDS.ZS, ${m.meta.licence}`)}`
    : html`${unknown()}<span class="w-muted">No beds value reported</span>`;
  const pop = r.pop
    ? html`<span class="w-muted">Population ${fmtPop(r.pop.value)} (${r.pop.year})</span>`
    : html`<span class="w-muted">Population ${unknown()}</span>`;
  const down =
    r.iso3 === "DEU"
      ? html`<a class="w-down" href="#germany" data-focus-key="world-open-germany">Open Germany<span aria-hidden="true"> →</span></a>`
      : html`<span class="w-muted w-nodown">No country screen yet</span>`;
  return html`<div class="w-focus" aria-live="polite">
    <b class="w-focus-name">${r.name}</b>${beds}${pop}${r.note ? html`<span class="w-note">${r.note}</span>` : ""}${down}
  </div>`;
}

function mapCard(m, ui, state) {
  const body = !libsReady()
    ? html`<p class="w-empty" role="alert">The map library didn't load. The country table below still works.</p>`
    : mapSvg(m, ui);
  return html`<section class="w-card" aria-labelledby="w-map-title">
    <header class="w-card-h">
      <div><h2 id="w-map-title">Hospital beds per 1,000 people</h2>
        <p>Latest year per country. Hover or select a country for its value and year.</p></div>
      ${state === "ready" ? prov("Official", `${m.meta.source}, ${m.meta.licence}`) : ""}
    </header>
    <div class="w-map-wrap">${body}<div class="w-tip" role="presentation" hidden></div></div>
    ${legend()}
    ${state === "ready" ? focusCard(m, ui) : ""}
  </section>`;
}

const COLS = [
  { key: "name", label: "Country", num: false },
  { key: "beds", label: "Beds per 1,000", num: true },
  { key: "year", label: "Year", num: true },
  { key: "pop", label: "Population", num: true, cls: "w-hide-s" },
];

function sortRows(rows, key, dir) {
  const val = (r) =>
    key === "name" ? r.name : key === "beds" ? r.beds?.value : key === "year" ? r.beds?.year : r.pop?.value;
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = val(a);
    const vb = val(b);
    // Unknown always sorts last, whatever the direction: it is not a small number.
    if (va === undefined || va === null) return vb === undefined || vb === null ? a.name.localeCompare(b.name) : 1;
    if (vb === undefined || vb === null) return -1;
    if (key === "name") return sign * va.localeCompare(vb);
    return sign * (va - vb) || a.name.localeCompare(b.name);
  });
}

function tableCard(m, ui, state) {
  if (state !== "ready" || !m.total) {
    return html`<section class="w-card"><header class="w-card-h"><div><h2>Countries</h2></div></header>
      <p class="w-empty">${state === "failed" ? "The World Bank data did not load. Values are Unknown, not 0." : "Loading the World Bank data…"}</p></section>`;
  }
  const sorted = sortRows(m.rows, ui.sort, ui.dir);
  const shown = ui.showAll ? sorted : sorted.slice(0, PAGE_ROWS);
  // Keep Germany and the selected country visible even when the list is cut.
  for (const iso of ["DEU", ui.selected]) {
    const r = m.byIso.get(iso);
    if (r && !shown.includes(r)) shown.push(r);
  }
  const th = (c) => {
    const on = ui.sort === c.key;
    const aria = on ? (ui.dir === "asc" ? "ascending" : "descending") : "none";
    return html`<th scope="col" class="${[c.num && "n", c.cls].filter(Boolean).join(" ")}" aria-sort="${aria}">
      <button type="button" class="w-sort${on ? " is-on" : ""}" data-sort="${c.key}" data-focus-key="world-sort-${c.key}">${c.label}<span class="w-sort-i" aria-hidden="true">${
        on ? (ui.dir === "asc" ? "▲" : "▼") : "↕"
      }</span></button></th>`;
  };
  const row = (r) => {
    const sel = r.iso3 === ui.selected;
    const name =
      r.iso3 === "DEU"
        ? html`<a href="#germany" class="w-name" data-focus-key="world-row-DEU">${r.name}<span class="w-go" aria-hidden="true"> →</span></a>`
        : html`<button type="button" class="w-name w-pick" data-iso="${r.iso3}" data-focus-key="world-row-${r.iso3}" aria-pressed="${sel}">${r.name}</button>`;
    const beds = r.beds
      ? html`<span class="w-cell-v"><i class="w-sw w-bin-${binOf(r.beds.value)}${r.old ? " w-sw-old" : ""}" aria-hidden="true"></i>${fmtBeds(r.beds.value)}</span>`
      : unknown();
    const year = r.beds?.year
      ? html`<span class="${r.old ? "w-year-old" : ""}" title="${r.old ? `More than ${OLD_AFTER_YEARS} years old` : ""}">${r.beds.year}${r.old ? html`<span class="w-sr"> (old)</span>` : ""}</span>`
      : unknown("–");
    const pop = r.pop ? html`<span title="${r.pop.year}">${fmtPop(r.pop.value)}</span>` : unknown();
    return html`<tr class="${[sel && "is-sel", r.iso3 === "DEU" && "is-de"].filter(Boolean).join(" ")}" data-iso="${r.iso3}">
      <th scope="row">${name}${r.note ? html`<sup class="w-fn" title="${r.note}">†</sup>` : ""}</th>
      <td class="n">${beds}</td><td class="n">${year}</td><td class="n w-hide-s">${pop}</td></tr>`;
  };
  const notes = m.rows.filter((r) => r.note);
  return html`<section class="w-card" aria-labelledby="w-table-title">
    <header class="w-card-h">
      <div><h2 id="w-table-title">Countries</h2><p>${m.total} countries in the World Bank list; select a column to sort. Unknown sorts last.</p></div>
      ${prov("Official", `${m.meta.source}, ${m.meta.licence}`)}
    </header>
    <div class="w-table-wrap">
      <table class="w-table">
        <caption class="w-sr">Hospital beds per 1,000 people by country, latest year, World Bank</caption>
        <thead><tr>${COLS.map(th)}</tr></thead>
        <tbody>${shown.map(row)}</tbody>
      </table>
    </div>
    <div class="w-card-f">
      <button type="button" class="w-more" data-more="1" data-focus-key="world-more">${
        ui.showAll ? `Show the first ${PAGE_ROWS}` : `Show all ${m.total} countries`
      }</button>
      ${notes.map((r) => html`<span class="w-muted">† ${r.name}: ${r.note}</span>`)}
    </div>
  </section>`;
}

function sources(m) {
  return sourcesFooter([
    {
      badge: prov("Official"),
      text: html`<b>World Bank WDI</b>, hospital beds per 1,000 people (SH.MED.BEDS.ZS) and population (SP.POP.TOTL), latest year per country${
        m.meta.asOf ? `, updated ${fmtDate(m.meta.asOf)}` : ""
      }. Licence ${m.meta.licence}. <a href="${m.meta.url || WB_URL}" rel="noopener" target="_blank">data.worldbank.org</a> · <a href="${WB_POP_URL}" rel="noopener" target="_blank">population</a>`,
    },
    {
      badge: prov("Official"),
      text: html`Boundaries: Natural Earth 1:110m via world-atlas (public domain, ISC). Shown for orientation; they imply no position on any border. <a href="${NE_URL}" rel="noopener" target="_blank">world-atlas</a>`,
    },
    {
      badge: prov("Unknown"),
      text: `Reading the map: hatched means the latest value is more than ${OLD_AFTER_YEARS} years old; grey means Unknown, never 0. The World Bank compiles this series from WHO, OECD and Eurostat.`,
    },
  ]);
}

// -- interaction -----------------------------------------------------------------------------------------
function uiState(ctx) {
  ctx.ui.world ??= { selected: "DEU", selectedName: "", sort: "beds", dir: "desc", showAll: false };
  return ctx.ui.world;
}

function bindMap(container, m) {
  const svg = container.querySelector(".w-map");
  const tip = container.querySelector(".w-tip");
  const wrap = container.querySelector(".w-map-wrap");
  if (!svg || !tip || !wrap) return;
  let last = null;
  const show = (event) => {
    const p = event.target.closest?.("path.w-c");
    if (!p) {
      tip.hidden = true;
      last = null;
      return;
    }
    if (p !== last) {
      last = p;
      const r = m.byIso.get(p.dataset.iso);
      const name = r?.name || p.dataset.name;
      tip.innerHTML = String(
        r?.beds
          ? html`<b>${name}</b>${fmtBeds(r.beds.value)} beds per 1,000 · ${r.beds.year}${r.old ? html`<em>older than ${OLD_AFTER_YEARS} years</em>` : ""}<span>World Bank · Official</span>`
          : html`<b>${name}</b>Unknown<span>${r ? "No beds value reported" : "Not in the World Bank list"}</span>`,
      );
    }
    const box = wrap.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    tip.hidden = false;
    const left = Math.min(Math.max(8, x + 14), box.width - tip.offsetWidth - 8);
    const top = y - tip.offsetHeight - 12 < 0 ? y + 16 : y - tip.offsetHeight - 12;
    tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  };
  svg.addEventListener("pointermove", show);
  svg.addEventListener("pointerleave", () => {
    tip.hidden = true;
    last = null;
  });
}

// -- entry point ------------------------------------------------------------------------------------------
let lastKey = "";
let lastData;
let lastModel = null;

export function render(container, ctx, { routeChanged = false } = {}) {
  const ui = uiState(ctx);
  const state = ctx.dataState ?? (ctx.data ? "ready" : "loading");
  if (ctx.data !== lastData || !lastModel) {
    lastData = ctx.data;
    lastModel = model(ctx.data);
  }
  const m = lastModel;

  // The view reacts only to its own state, not to the simulation clock: skip identical re-renders
  // so a hover tooltip or a scrolled table survives the twin's hourly ticks.
  const key = `${state}|${ui.selected}|${ui.sort}|${ui.dir}|${ui.showAll}|${libsReady()}`;
  const fresh = routeChanged || key !== lastKey || !container.querySelector(":scope > .world");
  if (fresh) {
    lastKey = key;
    container.innerHTML = String(html`<div class="pg world">
      ${head(m, state)}
      ${kpis(m, state)}
      <div class="w-stack">${mapCard(m, ui, state)}${tableCard(m, ui, state)}</div>
      ${levelsPanel("world", { place: "All countries" })}
      ${sources(m)}
    </div>`);
    bindMap(container, m);
  }

  container.onclick = (event) => {
    const sortBtn = event.target.closest("[data-sort]");
    if (sortBtn) {
      const k = sortBtn.dataset.sort;
      if (ui.sort === k) ui.dir = ui.dir === "asc" ? "desc" : "asc";
      else {
        ui.sort = k;
        ui.dir = k === "name" ? "asc" : "desc";
      }
      ctx.rerender();
      return;
    }
    if (event.target.closest("[data-more]")) {
      ui.showAll = !ui.showAll;
      ctx.rerender();
      return;
    }
    const pick = event.target.closest(".w-pick, path.w-c");
    if (pick) {
      const iso = pick.dataset.iso || "";
      ui.selected = iso || `?${pick.dataset.name ?? ""}`;
      ui.selectedName = pick.dataset.name ?? "";
      ctx.rerender();
    }
  };
}
