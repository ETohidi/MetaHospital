// The map levels: Country (Germany: the ministry screen on real DIVI data) and City (Berlin: real
// DIVI header, district map with the fictional demo twins). The World level is world.js. d3 is a
// global from index.html. The Berlin base map is built once and cached; each render only redraws
// the live overlays. The page anatomy (head, KPI strip, badges, sources) comes from page.js and
// the levels panel from levels.js, the same as on every other level.
//
// Real and simulated numbers never mix: the Germany page and the Berlin header show only the
// DIVI-Intensivregister (Live); the demo twins are a separate, labelled block (Simulated).

import berlinGeo from "../data/berlin.js";
import { BERLIN, HOSPITAL_BY_ID, HOSPITALS, OWN_HOSPITAL } from "../data/places.js";
import { chip, confBar, esc, html, meter, pct, plural, raw, UTIL_LABEL, utilTone } from "./dom.js";
import { levelsPanel as sharedLevelsPanel } from "./levels.js";
import { kpiStrip, pageHead, pill, prov, PROV_HELP, PROV_LABEL, sourcesFooter as pageSources } from "./page.js";

const VIEWBOX = { 3: [960, 640] };
const PULSE_MS = 2400;
const FLOW_MS = 1200;
const PIN_R_MAX = 14;

// Label sizes in viewBox units; maps.css enlarges them on narrow maps, so the Berlin
// layout reserves room for labels this much bigger than the base size.
const FS = { pinName: 15, pinDetail: 13, link: 12.5, district: 11 };
const RESERVE = 1.3;

const f1 = (n) => Math.round(n * 10) / 10;
// Keep animations continuous across re-renders: start each one at the current phase.
const phase = (ms) => `animation-delay:-${Date.now() % ms}ms`;

// -- numbers ------------------------------------------------------------------
const free = (u) => Math.max(0, u.bedsStaffed - u.bedsOccupied);
const util = (u) => (u.bedsStaffed > 0 ? u.bedsOccupied / u.bedsStaffed : u.bedsOccupied > 0 ? 1 : 0);
const sum = (xs, fn) => xs.reduce((n, x) => n + fn(x), 0);

function hospitalStats(h) {
  const { ED, ICU, Ward } = h.units;
  const worstUnit = util(ICU) >= util(Ward) ? "ICU" : "Ward";
  const worst = util(h.units[worstUnit]);
  return {
    ...h,
    place: HOSPITAL_BY_ID[h.id],
    index: HOSPITALS.findIndex((x) => x.id === h.id),
    freeICU: free(ICU),
    freeWard: free(Ward),
    beds: ED.bedsTotal + ICU.bedsTotal + Ward.bedsTotal,
    inUse: ED.bedsOccupied + ICU.bedsOccupied + Ward.bedsOccupied,
    worst,
    worstUnit,
    tone: utilTone(worst),
  };
}

function networkStats(snap) {
  const hospitals = snap.hospitals.map(hospitalStats);
  const worstHospital = hospitals.reduce((a, b) => (b.worst > a.worst ? b : a), hospitals[0]);
  const pooled = (u) =>
    sum(hospitals, (h) => h.units[u].bedsOccupied) / Math.max(1, sum(hospitals, (h) => h.units[u].bedsStaffed));
  return {
    hospitals,
    count: hospitals.length,
    beds: sum(hospitals, (h) => h.beds),
    inUse: sum(hospitals, (h) => h.inUse),
    freeICU: sum(hospitals, (h) => h.freeICU),
    freeWard: sum(hospitals, (h) => h.freeWard),
    icuTone: utilTone(pooled("ICU")),
    wardTone: utilTone(pooled("Ward")),
    worstHospital,
    worstTone: worstHospital ? worstHospital.tone : "ok",
  };
}

/** Divert suggestions per receiving hospital in the plan that is waiting for a decision. */
function divertsByHospital(snap) {
  const counts = {};
  for (const p of snap.pendingBundle?.proposals ?? []) {
    for (const a of p.actions) {
      if (a.type === "divert_to" && a.hospital) counts[a.hospital] = (counts[a.hospital] ?? 0) + 1;
    }
  }
  return counts;
}

const acceptsText = (report) =>
  report ? `accepts ICU ${report.canAccept.ICU} · Ward ${report.canAccept.Ward}` : "no report yet";

// -- shared bits ----------------------------------------------------------------
function emergencyChip(snap) {
  return snap.surge ? chip(`Emergency at ${OWN_HOSPITAL.short}: ${snap.surge}`, "crit") : "";
}



function stat(value, label) {
  return html`<div class="stat"><span class="stat-value">${value}</span><span class="stat-label">${label}</span></div>`;
}

function libsReady() {
  const { d3 } = globalThis;
  return Boolean(d3 && typeof d3.geoPath === "function");
}

function geoPath(projection) {
  const path = globalThis.d3.geoPath(projection);
  if (typeof path.digits === "function") path.digits(1);
  return path;
}

/** Screen length of `km` kilometres along the parallel at `lat` (for scale bars). */
function kmToUnits(projection, lon, lat, km) {
  const dLon = km / (111.32 * Math.cos((lat * Math.PI) / 180));
  return projection([lon + dLon, lat])[0] - projection([lon, lat])[0];
}

function scaleBar(x, y, length, label) {
  return `<g class="map-scale" aria-hidden="true">
    <path class="map-scale-bar" fill="none" d="M${f1(x)} ${f1(y - 5)}V${f1(y)}H${f1(x + length)}V${f1(y - 5)}"/>
    <text class="map-scale-label" x="${f1(x)}" y="${f1(y - 9)}">${label}</text>
  </g>`;
}

// -- label layout (Berlin) ----------------------------------------------------------
const overlaps = (a, b, pad = 3) => a.x0 < b.x1 + pad && a.x1 + pad > b.x0 && a.y0 < b.y1 + pad && a.y1 + pad > b.y0;
const fits = (b, [w, h]) => b.x0 >= 6 && b.y0 >= 6 && b.x1 <= w - 6 && b.y1 <= h - 6;
const textW = (text, fs, k = 0.57) => text.length * fs * k;

function anchoredBox(ax, anchor, width, y0, y1) {
  return anchor === "end" ? { x0: ax - width, x1: ax, y0, y1 } : { x0: ax, x1: ax + width, y0, y1 };
}

/** Two-line label: a name whose baseline sits 0.15em above ay, a detail line below it. */
function twoLineBox(ax, ay, anchor, nameText, detailText, fsName, fsDetail) {
  const width = Math.max(textW(nameText, fsName, 0.62), textW(detailText, fsDetail));
  const base = ay - 0.15 * fsName;
  return anchoredBox(ax, anchor, width, base - 0.8 * fsName, base + 1.25 * fsDetail + 0.3 * fsDetail);
}

function districtLines(name) {
  const i = name.indexOf("-");
  return i > 0 ? [name.slice(0, i + 1), name.slice(i + 1)] : [name];
}

function districtBox(cx, cy, lines, fs) {
  // Uppercase, letter-spaced, plus a margin so neighbouring names never touch.
  const width = Math.max(...lines.map((l) => textW(l, fs, 0.9))) + 8;
  const height = lines.length * 1.15 * fs + 4;
  return { x0: cx - width / 2, x1: cx + width / 2, y0: cy - height / 2, y1: cy + height / 2 };
}

/** Candidate label spots inside a district on a 10-unit grid, nearest the centroid first. */
function labelSpots(feature, projection, path, step = 10) {
  const { d3 } = globalThis;
  const [[x0, y0], [x1, y1]] = path.bounds(feature);
  const [cx, cy] = path.centroid(feature);
  const inside = ([x, y]) => d3.geoContains(feature, projection.invert([x, y]));
  const spots = [[cx, cy]];
  for (let y = y0 + step / 2; y < y1; y += step) {
    for (let x = x0 + step / 2; x < x1; x += step) spots.push([x, y]);
  }
  const dist = ([x, y]) => Math.hypot(x - cx, y - cy);
  return { inside, spots: spots.filter(inside).sort((a, b) => dist(a) - dist(b)) };
}

// -- base maps (cached per level) ----------------------------------------------------------
const cache = new Map();

function baseMap(level) {
  if (!cache.has(level)) cache.set(level, BUILDERS[level]());
  return cache.get(level);
}


function buildBerlin() {
  const { d3 } = globalThis;
  const [w, h] = VIEWBOX[3];
  const projection = d3.geoMercator().fitExtent(
    [
      [16, 16],
      [w - 16, h - 16],
    ],
    berlinGeo,
  );
  const path = geoPath(projection);
  const withHospital = new Set(HOSPITALS.map((x) => x.district));
  // Pin and connector labels stay visible on mid-size maps, where they are drawn larger, so
  // they keep clear of each other at that size. District names are hidden there, so they
  // only need to keep clear of the base-size labels.
  const reservedBig = [];
  const reservedBase = [];
  const isFree = (box, reserved) => fits(box, [w, h]) && !reserved.some((b) => overlaps(box, b));

  // Pins: radius by total beds (area-true), our hospital gets an extra ring.
  const maxBeds = Math.max(...HOSPITALS.map((x) => sum(Object.values(x.seed), (s) => s[0])));
  const pins = HOSPITALS.map((x, index) => {
    const [px, py] = projection([x.lon, x.lat]);
    const beds = sum(Object.values(x.seed), (s) => s[0]);
    const r = PIN_R_MAX * Math.sqrt(beds / maxBeds);
    const box = { x0: px - r - 6, x1: px + r + 6, y0: py - r - 6, y1: py + r + 6 };
    reservedBig.push(box);
    reservedBase.push(box);
    return { ...x, index, x: px, y: py, r };
  });

  // Pin labels go left of the pin in the west half of the cluster, right in the east half.
  const meanX = sum(pins, (p) => p.x) / pins.length;
  for (const p of pins) {
    const name = `${p.short}${p.isOwn ? " (ours)" : ""}`;
    const detail = "ICU 99 free · Ward 99 free";
    const sides = p.x < meanX ? ["end", "start"] : ["start", "end"];
    const options = sides.map((anchor) => {
      const ax = anchor === "end" ? p.x - p.r - 8 : p.x + p.r + 8;
      const box = (k) => twoLineBox(ax, p.y, anchor, name, detail, FS.pinName * k, FS.pinDetail * k);
      return { anchor, ax, big: box(RESERVE), small: box(1) };
    });
    const pick = options.find((o) => isFree(o.big, reservedBig)) ?? options[0];
    p.label = { anchor: pick.anchor, x: pick.ax, y: p.y };
    reservedBig.push(pick.big);
    reservedBase.push(pick.small);
  }

  // Connectors from our hospital to each neighbour: a gentle arc, its label beyond the bulge.
  const own = pins.find((p) => p.isOwn);
  const links = pins
    .filter((p) => !p.isOwn)
    .map((n) => {
      const dx = n.x - own.x;
      const dy = n.y - own.y;
      const len = Math.hypot(dx, dy) || 1;
      const bulge = Math.min(40, len * 0.45);
      const options = [1, -1].map((sign) => {
        const nx = (-dy / len) * sign;
        const ny = (dx / len) * sign;
        const mx = (own.x + n.x) / 2;
        const my = (own.y + n.y) / 2;
        const c = [mx + nx * bulge, my + ny * bulge];
        const lx = mx + nx * (bulge / 2 + 8);
        const ly = my + ny * (bulge / 2 + 8);
        const anchor = nx >= 0 ? "start" : "end";
        const box = (k) => {
          const fs = FS.link * k;
          const width = Math.max(textW("accepts ICU 99 · Ward 99", fs), textW("99 diverts suggested", fs));
          const top = ny < 0 ? ly - 2.2 * fs : ly - 0.5 * fs;
          return anchoredBox(lx, anchor, width, top, top + 2.6 * fs);
        };
        return { c, anchor, lx, ly, up: ny < 0, big: box(RESERVE), small: box(1) };
      });
      const pick = options.find((o) => isFree(o.big, reservedBig)) ?? options[0];
      reservedBig.push(pick.big);
      reservedBase.push(pick.small);
      const end = (p, towards) => {
        const ex = towards[0] - p.x;
        const ey = towards[1] - p.y;
        const el = Math.hypot(ex, ey) || 1;
        return [p.x + (ex / el) * (p.r + 4), p.y + (ey / el) * (p.r + 4)];
      };
      const [x0, y0] = end(own, pick.c);
      const [x1, y1] = end(n, pick.c);
      return {
        id: n.id,
        name: n.name,
        d: `M${f1(x0)} ${f1(y0)}Q${f1(pick.c[0])} ${f1(pick.c[1])} ${f1(x1)} ${f1(y1)}`,
        label: { anchor: pick.anchor, x: pick.lx, y: pick.ly, up: pick.up },
      };
    });

  // Scale bar bottom-left; keep district names off it.
  const barLen = kmToUnits(projection, BERLIN.lon, BERLIN.lat, 5);
  reservedBase.push({ x0: 16, x1: 16 + barLen + 10, y0: h - 44, y1: h - 12 });

  // District names: the free spot inside the district nearest its centroid, or no name at all
  // (the district still names itself on hover).
  const districts = berlinGeo.features.map((f) => {
    const name = f.properties.name;
    const lines = districtLines(name);
    let label = null;
    const { inside, spots } = labelSpots(f, projection, path);
    for (const [x, y] of spots) {
      const box = districtBox(x, y, lines, FS.district);
      const shrink = (box.x1 - box.x0) * 0.2;
      if (inside([box.x0 + shrink, y]) && inside([box.x1 - shrink, y]) && isFree(box, reservedBase)) {
        reservedBase.push(box);
        label = { x, y };
        break;
      }
    }
    return { name, d: path(f), lines, label, hasHospital: withHospital.has(name) };
  });

  const districtLabels = districts
    .filter((d) => d.label)
    .map((d) => {
      const first = 0.35 - ((d.lines.length - 1) * 1.15) / 2;
      const spans = d.lines
        .map((line, i) => `<tspan x="${f1(d.label.x)}" dy="${i === 0 ? first.toFixed(3) : "1.15"}em">${esc(line)}</tspan>`)
        .join("");
      return `<text class="map-district-label" x="${f1(d.label.x)}" y="${f1(d.label.y)}">${spans}</text>`;
    })
    .join("");

  const base = `
    <rect class="map-water" x="0" y="0" width="${w}" height="${h}"/>
    ${districts
      .map(
        (d) =>
          `<path class="map-district${d.hasHospital ? " has-hospital" : ""}" d="${d.d}"><title>${esc(d.name)}</title></path>`,
      )
      .join("")}
    ${districtLabels}
    ${scaleBar(24, h - 20, barLen, "5 km")}`;
  return { base, pins, links, districts };
}

const BUILDERS = { 3: buildBerlin };

// -- the map cards ----------------------------------------------------------------------------
function missingCard() {
  return html`<div class="card map-missing" role="alert">
    <p>The map library didn't load. Check your connection and reload.</p>
  </div>`;
}

function svg(level, label, content) {
  const [w, h] = VIEWBOX[level];
  const cls = { 3: "berlin" }[level];
  return html`<svg class="map-svg map-svg-${cls}" viewBox="0 0 ${w} ${h}" role="group" aria-label="${label}">${content}</svg>`;
}

/** An SVG label of stacked lines. No whitespace between the tspans, so end-anchored text lines up. */
function svgText(cls, x, y, anchor, spans) {
  const tx = f1(x);
  const inner = spans
    .filter(Boolean)
    .map((s) => html`<tspan${s.cls ? raw(` class="${s.cls}"`) : ""} x="${tx}" dy="${s.dy}">${s.text}</tspan>`);
  return html`<text class="${cls}" text-anchor="${anchor}" x="${tx}" y="${f1(y)}">${inner}</text>`;
}


function berlinMap(snap, net, ctx) {
  const m = baseMap(3);
  const stats = Object.fromEntries(net.hospitals.map((h) => [h.id, h]));
  const diverts = divertsByHospital(snap);

  const links = m.links.map((l) => {
    const report = snap.nearbyCapacity?.[l.name];
    const n = diverts[l.name] ?? 0;
    const { anchor, x, y, up } = l.label;
    // Above the arc the label grows upward, so its last line stays next to the line.
    const first = up && n ? "-0.9em" : "0.35em";
    return html`<g class="map-link-group${n ? " is-divert" : ""}">
      <path class="map-link" fill="none" d="${l.d}"${n ? raw(` style="${phase(FLOW_MS)}"`) : ""}/>
      ${svgText("map-link-label", x, y, anchor, [
        { dy: first, text: acceptsText(report) },
        n && { cls: "map-link-divert", dy: "1.25em", text: `${plural(n, "divert")} suggested` },
      ])}
    </g>`;
  });

  const pins = m.pins.map((p) => {
    const s = stats[p.id];
    if (!s) return "";
    const name = `${p.short}${p.isOwn ? " (ours)" : ""}`;
    const summary = `${s.name}${p.isOwn ? ", our hospital" : ""}: ICU ${s.freeICU} free, Ward ${s.freeWard} free, ${UTIL_LABEL[s.tone].toLowerCase()}.`;
    const { anchor, x, y } = p.label;
    return html`<g class="map-pin map-pin-${p.index}${p.isOwn ? " is-own" : ""}" data-go="${ctx.routes.hospital(p.id)}"
      role="link" tabindex="0" data-focus-key="pin-${p.id}" aria-label="${summary} Open hospital.">
      <title>${summary}</title>
      <circle class="map-hit-area" cx="${f1(p.x)}" cy="${f1(p.y)}" r="${f1(p.r + 10)}"/>
      ${p.isOwn && snap.surge ? html`<circle class="map-pulse is-crit" cx="${f1(p.x)}" cy="${f1(p.y)}" r="${f1(p.r + 3)}" style="${phase(PULSE_MS)}"/>` : ""}
      <circle class="map-focus" cx="${f1(p.x)}" cy="${f1(p.y)}" r="${f1(p.r + (p.isOwn ? 10 : 6))}"/>
      ${p.isOwn ? html`<circle class="map-pin-own" cx="${f1(p.x)}" cy="${f1(p.y)}" r="${f1(p.r + 4.5)}"/>` : ""}
      <circle class="map-pin-dot is-${s.tone}" cx="${f1(p.x)}" cy="${f1(p.y)}" r="${f1(p.r)}"/>
      ${svgText("map-label map-pin-label", x, y, anchor, [
        { cls: "map-pin-name", dy: "-0.15em", text: name },
        { cls: "map-pin-detail", dy: "1.25em", text: `ICU ${s.freeICU} free · Ward ${s.freeWard} free` },
      ])}
    </g>`;
  });

  return html`<div class="card card-flush map-card map-card-berlin">
    ${svg(3, "Map of Berlin's 12 districts with the three fictional demo twins. Select a twin to open it.", html`${raw(m.base)}${links}${pins}`)}
    <div class="map-foot">
      <div class="legend">
        <span>${badge("simulated", "Demo twins")}</span>
        <span><i class="swatch map-sw-tone is-ok"></i>Up to 85% in use</span>
        <span><i class="swatch map-sw-tone is-warn"></i>85–95%</span>
        <span><i class="swatch map-sw-tone is-crit"></i>Over 95%</span>
        <span><i class="swatch map-sw-own"></i>Ours</span>
        <span><i class="swatch map-sw-link"></i>Latest capacity report</span>
      </div>
      <span class="faint">Fictional hospitals, simulated. Pin size: total beds. Colour: the fuller of ICU and Ward.</span>
    </div>
  </div>`;
}



function reportBlock(report) {
  if (!report) return html`<div class="map-report"><span class="muted">No capacity report yet.</span></div>`;
  return html`<div class="map-report">
    <div class="map-report-head">
      <span>Can accept <strong>ICU ${report.canAccept.ICU}</strong> · <strong>Ward ${report.canAccept.Ward}</strong></span>
      ${confBar(report.confidence)}
    </div>
    <div class="faint">Valid until ${report.validUntil}. ${report.note}</div>
  </div>`;
}

function hospitalCard(h, snap, ctx) {
  const place = h.place ?? {};
  const rows = ["ED", "ICU", "Ward"].map((u) => {
    const b = h.units[u];
    return html`<span class="map-unit-name">${u}</span>
      ${meter(util(b), { label: `${u} beds in use at ${h.name}` })}
      <span class="mono map-unit-num">${b.bedsOccupied} / ${b.bedsStaffed}</span>`;
  });
  return html`<article class="card map-hcard map-hcard-${h.index}${h.isOwn ? " is-own" : ""}">
    <div class="map-hcard-head">
      <span class="map-dot is-${h.tone}" role="img" aria-label="${UTIL_LABEL[h.tone]}" title="${UTIL_LABEL[h.tone]}: ${h.worstUnit} ${pct(h.worst)} in use"></span>
      <div class="map-hcard-title">
        <h3>${h.name}</h3>
        <div class="faint">${place.district ?? ""}</div>
      </div>
      <span class="row">${badge("simulated", "Demo twin")} ${h.isOwn ? chip("ours", "accent", { plain: true }) : ""}</span>
    </div>
    <div class="map-free">
      ${stat(h.freeICU, "ICU beds free")} ${stat(h.freeWard, "Ward beds free")}
    </div>
    <div class="map-units">
      <span class="map-units-head">Unit</span><span class="map-units-head">In use</span><span class="map-units-head map-unit-num">in use / usable today</span>
      ${rows}
    </div>
    ${reportBlock(snap.nearbyCapacity?.[h.name])}
    ${h.isOwn && snap.surge ? html`<div class="row">${emergencyChip(snap)}</div>` : ""}
    <div class="row">
      <a class="btn" href="#${ctx.routes.hospital(h.id)}" data-focus-key="open-${h.id}">Open ${place.short ?? h.name}</a>
    </div>
  </article>`;
}

function regionalNote(snap) {
  const diverts = divertsByHospital(snap);
  const total = sum(Object.values(diverts), (n) => n);
  const plan = snap.pendingBundle;
  let now;
  if (!plan) now = "No plan is waiting for a decision right now.";
  else if (!total) now = `No diverts needed in the ${plan.hourRange} plan.`;
  else {
    const where = Object.entries(diverts)
      .map(([name, n]) => `${n} to ${name}`)
      .join(", ");
    now = `The ${plan.hourRange} plan suggests ${plural(total, "divert")}: ${where}.`;
  }
  return html`<div class="card map-coordinator">
    <div class="eyebrow">Regional coordinator</div>
    <p>
      Every hour it asks each hospital how many ICU and Ward patients it can accept. When ${OWN_HOSPITAL.name} has no
      ICU bed for a patient, it matches them to a hospital with room and adds a divert to the plan. The charge nurse
      approves or rejects it with the rest of the plan.
    </p>
    <p class="muted">${now}</p>
  </div>`;
}

function berlinPanel(snap, net, ctx) {
  const ordered = [...net.hospitals].sort((a, b) => Number(b.isOwn) - Number(a.isOwn));
  return html`${ordered.map((h) => hospitalCard(h, snap, ctx))}${regionalNote(snap)}`;
}



// =====================================================================================================
// Real data: the DIVI-Intensivregister daily report (adults), per Land, as loaded by main.js.
// =====================================================================================================
// DIVI numbers the Länder 01..16 in this order.
const LAND_CODES = ["SH", "HH", "NI", "HB", "NW", "HE", "RP", "BW", "BY", "SL", "BE", "BB", "MV", "SN", "ST", "TH"];
const LAND_NAME = {
  SH: "Schleswig-Holstein",
  HH: "Hamburg",
  NI: "Niedersachsen",
  HB: "Bremen",
  NW: "Nordrhein-Westfalen",
  HE: "Hessen",
  RP: "Rheinland-Pfalz",
  BW: "Baden-Württemberg",
  BY: "Bayern",
  SL: "Saarland",
  BE: "Berlin",
  BB: "Brandenburg",
  MV: "Mecklenburg-Vorpommern",
  SN: "Sachsen",
  ST: "Sachsen-Anhalt",
  TH: "Thüringen",
};
// The five Kleeblatt clusters the Länder use to move ICU patients between each other.
const KLEEBLATT = {
  Nord: ["SH", "HH", "NI", "HB", "MV"],
  Ost: ["BE", "BB", "SN", "ST", "TH"],
  Süd: ["BY"],
  Südwest: ["BW", "HE", "RP", "SL"],
  West: ["NW"],
};
const CLUSTER_OF = Object.fromEntries(Object.entries(KLEEBLATT).flatMap(([k, codes]) => codes.map((c) => [c, k])));
// Equal-area tile grid, [column, row]: every Land gets the same tile, so Bremen counts as much as Bayern.
const TILE_POS = {
  SH: [2, 0],
  HB: [1, 1],
  HH: [2, 1],
  MV: [3, 1],
  NW: [0, 2],
  NI: [1, 2],
  ST: [2, 2],
  BE: [3, 2],
  BB: [4, 2],
  RP: [0, 3],
  HE: [1, 3],
  TH: [2, 3],
  SN: [3, 3],
  SL: [0, 4],
  BW: [1, 4],
  BY: [2, 4],
};
const TILE = 80;
/** Alert only when a Land is at least this full AND has fewer free beds, for this many days in a row. */
export const ALERT_RULE = { pct: 90, free: 10, days: 3 };
const WATCH_PCT = 85;
const STALE_DAYS = 2;
const SPARK_DAYS = 28;

const DIVI = {
  name: "DIVI-Intensivregister",
  publisher: "Robert Koch-Institut",
  url: "https://github.com/robert-koch-institut/Intensivkapazitaeten_und_COVID-19-Intensivbettenbelegung_in_Deutschland",
  licence: "CC BY 4.0",
};
const DIVI_SITES_URL = "https://www.intensivregister.de";

// Annual reference values (Official): cited, not fetched. Shown only as context next to the live figures.
const CONTEXT_DE = [
  { label: "Hospitals", value: "1,840", note: "on 2,755 sites" },
  { label: "Hospital beds", value: "473,606" },
];
const DESTATIS = {
  name: "Destatis Krankenhausverzeichnis 2024",
  url: "https://www.statistikportal.de/de/veroeffentlichungen/krankenhausverzeichnis",
  licence: "dl-de/by-2.0",
  year: 2024,
};
const WB_BEDS = {
  value: "7.55",
  year: 2023,
  name: "World Bank SH.MED.BEDS.ZS",
  url: "https://data.worldbank.org/indicator/SH.MED.BEDS.ZS?locations=DE",
  licence: "CC BY 4.0",
};
const BERLIN_PLAN = {
  value: "23,620",
  sites: 64,
  name: "Berlin hospital register (plan hospitals)",
  url: "https://gdi.berlin.de/services/wfs/krankenhaeuser",
  licence: "dl-de/zero-2.0",
};
const BERLIN_STAT = {
  value: "20,119",
  hospitals: 85,
  year: 2024,
  name: "Amt für Statistik Berlin-Brandenburg, Krankenhäuser 2024",
  url: "https://download.statistik-berlin-brandenburg.de/0c8e593e02222e3b/ab037c6d31e5/SB_A04-02-00_2024j01_BE.pdf",
  licence: "CC BY 3.0 DE",
};

// -- tolerant reading of the data file -------------------------------------------------------------
// Values may be plain numbers or provenance records {value, kind, source, url, licence, asOf}.
function unwrap(x) {
  if (x && typeof x === "object" && !Array.isArray(x)) return x.value ?? x.v ?? null;
  return x;
}
function val(x) {
  const v = unwrap(x);
  if (v === null || v === undefined || v === "" || v === "NA") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function pick(o, ...keys) {
  for (const k of keys) {
    let v = o;
    for (const part of k.split(".")) v = v?.[part];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}
const num = (o, ...keys) => val(pick(o, ...keys));

function landCode(r, key) {
  for (const c0 of [pick(r, "code", "ab", "abbr", "short", "iso", "id", "bundesland_id", "landId"), key]) {
    if (c0 === undefined || c0 === null) continue;
    const c = String(c0).replace(/^DE-/i, "").toUpperCase();
    if (LAND_NAME[c]) return c;
    const n = Number(c);
    if (Number.isInteger(n) && n >= 1 && n <= 16) return LAND_CODES[n - 1];
  }
  const name = pick(r, "name", "bundesland_name", "land");
  return Object.keys(LAND_NAME).find((k) => LAND_NAME[k] === name) ?? null;
}

function figures(r) {
  if (!r) return {};
  return {
    areas: num(r, "areas", "reportingAreas", "reporting_areas", "anzahl_meldebereiche"),
    occupied: num(r, "occupied", "occ", "icuOccupied", "intensivbetten_belegt"),
    free: num(r, "free", "icuFree", "intensivbetten_frei"),
    reserve: num(r, "reserve", "reserve7d", "emergencyReserve", "intensivbetten_7_tage_notfallreserve"),
    vent: num(
      r,
      "ventFree",
      "vent",
      "invasiveVentilationFree",
      "freeInvasiveVentilation",
      "kapazitaeten_frei_invasive_beatmung_gesamt",
    ),
    regular: num(r, "status.regular", "operating.regular", "regular", "betriebssituation_regulaerer_betrieb"),
    partly: num(r, "status.partly", "status.partial", "operating.partly", "partly", "betriebssituation_teilweise_eingeschraenkt"),
    limited: num(r, "status.limited", "operating.limited", "limited", "betriebssituation_eingeschraenkt"),
    noStatement: num(
      r,
      "status.noStatement",
      "status.none",
      "operating.noStatement",
      "noStatement",
      "betriebssituation_keine_angabe",
    ),
    staff: num(r, "limits.staff", "limitations.staff", "staffLimited", "staff", "einschraenkung_personal"),
  };
}

const occPct = (f) => (f.occupied != null && f.free != null && f.occupied + f.free > 0 ? (100 * f.occupied) / (f.occupied + f.free) : null);

function seriesOf(r) {
  let s = pick(r, "series", "history", "days", "daily");
  if (!s) return [];
  if (!Array.isArray(s) && Array.isArray(s.dates)) {
    s = s.dates.map((date, i) => ({ date, occupied: s.occupied?.[i], free: s.free?.[i], pct: s.pct?.[i] }));
  }
  if (!Array.isArray(s)) return [];
  const out = s.map((e) => {
    let d;
    if (Array.isArray(e)) d = { date: e[0], occupied: val(e[1]), free: val(e[2]) };
    else if (e && typeof e === "object") {
      d = {
        date: pick(e, "date", "datum", "day"),
        occupied: num(e, "occupied", "occ", "intensivbetten_belegt"),
        free: num(e, "free", "intensivbetten_frei"),
        raw: num(e, "pct", "occupancy"),
      };
    } else d = { raw: val(e) };
    const p = occPct(d);
    d.pct = p ?? (d.raw == null ? null : d.raw <= 1 ? d.raw * 100 : d.raw);
    return d;
  });
  if (out.every((d) => d.date)) out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

const dayNum = (iso) => Math.floor(Date.parse(`${String(iso).slice(0, 10)}T12:00:00Z`) / 864e5);

/** Normalise realData().de into {asOf, source, laender[16], total}. Throws when the shape is unusable. */
export function normalizeDE(raw) {
  if (!raw || typeof raw !== "object") throw new Error("no data");
  let list = pick(raw, "laender", "länder", "lands", "states", "regions", "bundeslaender");
  if (list && !Array.isArray(list)) list = Object.entries(list).map(([key, v]) => ({ ...v, __key: key }));
  if (!Array.isArray(list) || !list.length) throw new Error("no Länder in the data");

  let asOf = pick(raw, "asOf", "date", "reportDate", "meta.asOf", "provenance.asOf", "source.asOf");
  const laender = [];
  for (const r of list) {
    const code = landCode(r, r.__key);
    if (!code) continue;
    const latest = figures(pick(r, "latest", "today", "current") ?? r);
    const series = seriesOf(r).slice(-60);
    const last = series[series.length - 1];
    if (latest.occupied == null && last) Object.assign(latest, { occupied: last.occupied, free: last.free });
    asOf ??= pick(r, "asOf", "occupied.asOf", "latest.asOf") ?? last?.date;
    laender.push({ code, name: LAND_NAME[code], cluster: CLUSTER_OF[code], ...latest, series });
  }
  if (!laender.length || laender.every((l) => l.occupied == null)) throw new Error("no ICU figures in the data");
  asOf = asOf ? String(unwrap(asOf)).slice(0, 10) : null;
  // Make sure the latest day closes every series (the alert rule and the sparkline read it).
  for (const l of laender) {
    const last = l.series[l.series.length - 1];
    if (asOf && l.occupied != null && (!last || (last.date && last.date < asOf))) {
      l.series.push({ date: asOf, occupied: l.occupied, free: l.free, pct: occPct(l) });
    }
    l.pct = occPct(l);
    l.streak = alertStreak(l.series);
  }
  const order = Object.keys(LAND_NAME);
  laender.sort((a, b) => order.indexOf(a.code) - order.indexOf(b.code));

  const summed = sumFigures(laender);
  const given = figures(pick(raw, "national", "germany", "total", "de", "DE"));
  const total = Object.fromEntries(Object.entries(summed).map(([k, v]) => [k, given[k] ?? v]));
  const nationalSeries = seriesOf(pick(raw, "national", "germany", "total") ?? {});
  total.series = nationalSeries.length ? nationalSeries : sumSeries(laender);
  total.pct = occPct(total);
  const src = pick(raw, "source", "provenance", "meta") ?? {};
  const source = {
    name: typeof src === "string" ? src : src.name ?? src.source ?? DIVI.name,
    url: src.url ?? pick(raw, "url") ?? DIVI.url,
    licence: src.licence ?? src.license ?? pick(raw, "licence", "license") ?? DIVI.licence,
  };
  return { asOf, source, laender, total, generatedAt: pick(raw, "generatedAt", "meta.generatedAt") ?? null };
}

function sumFigures(rows) {
  const keys = ["areas", "occupied", "free", "reserve", "vent", "regular", "partly", "limited", "noStatement", "staff"];
  return Object.fromEntries(
    keys.map((k) => [k, rows.some((r) => r[k] == null) ? null : rows.reduce((n, r) => n + r[k], 0)]),
  );
}

/** National series = the sum over Länder, on days every Land reported. */
function sumSeries(laender) {
  const byDate = new Map();
  for (const l of laender) {
    for (const d of l.series) {
      if (!d.date || d.occupied == null || d.free == null) continue;
      const e = byDate.get(d.date) ?? { date: d.date, occupied: 0, free: 0, n: 0 };
      e.occupied += d.occupied;
      e.free += d.free;
      e.n += 1;
      byDate.set(d.date, e);
    }
  }
  return [...byDate.values()]
    .filter((e) => e.n === laender.length)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((e) => ({ ...e, pct: occPct(e) }));
}

/** Consecutive latest days on which the Land met the alert rule (≥90% occupied AND <10 free). */
export function alertStreak(series) {
  let n = 0;
  for (let i = series.length - 1; i >= 0; i--) {
    const d = series[i];
    if (d.pct == null || d.free == null || d.pct < ALERT_RULE.pct || d.free >= ALERT_RULE.free) break;
    n += 1;
    const prev = series[i - 1];
    if (prev?.date && d.date && dayNum(d.date) - dayNum(prev.date) !== 1) break;
  }
  return n;
}

/** Status of a Land: crit = alert rule held for 3 days; warn = ≥85% or under 10 free today. */
export function landStatus(l) {
  if (l.streak >= ALERT_RULE.days) return { tone: "crit", label: "Alert" };
  if ((l.pct != null && l.pct >= WATCH_PCT) || (l.free != null && l.free < ALERT_RULE.free)) {
    return { tone: "warn", label: "Watch" };
  }
  return { tone: "ok", label: "Normal" };
}

/**
 * Reads the DIVI data from the context: ctx.data.de (main.js, with ctx.dataState) or ctx.realData().de.
 * Returns {state: "ready"|"loading"|"failed", de?, error?}.
 */
function realDE(ctx) {
  let real = ctx.realData ?? ctx.data;
  if (typeof real === "function") {
    try {
      real = real();
    } catch (e) {
      return { state: "failed", error: e.message };
    }
  }
  const declared = ctx.dataState ?? real?.state ?? null;
  if (!("realData" in ctx) && !("data" in ctx)) return { state: "failed", error: "This build does not load real data." };
  const err = real?.errors?.de ?? null;
  let raw = real?.de ?? real?.DE ?? real?.germany ?? real?.divi ?? null;
  if (raw && !pick(raw, "laender", "länder", "lands", "states", "regions", "bundeslaender")) {
    raw = pick(raw, "icu", "icuDaily", "icu_daily", "daily") ?? raw;
  }
  if (raw == null || raw === false) {
    if (declared === "loading" || (declared == null && real == null && !err)) return { state: "loading" };
    return { state: "failed", error: err ? String(err.message ?? err) : "The DIVI file is missing from the loaded data." };
  }
  if (raw instanceof Error || raw.error) return { state: "failed", error: String(raw.message ?? raw.error) };
  try {
    return { state: "ready", de: normalizeDE(raw) };
  } catch (e) {
    return { state: "failed", error: `The data file has an unexpected shape (${e.message}).` };
  }
}

// -- formatting -----------------------------------------------------------------------------------
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmt = (n) => (n == null ? "–" : Math.round(n).toLocaleString("en-US"));
const fmtPct = (p, d = 1) => (p == null ? "–" : `${p.toFixed(d)}%`);
function fmtDate(iso) {
  if (!iso) return "date unknown";
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}
function ageDays(iso) {
  if (!iso) return null;
  return Math.floor(Date.now() / 864e5) - dayNum(iso);
}
const seqStep = (p) => (p == null ? 0 : p >= 90 ? 5 : p >= 85 ? 4 : p >= 80 ? 3 : p >= 75 ? 2 : 1);

// =====================================================================================================
// Shared page pieces for the map levels: head, provenance badge, KPI strip, sources footer, ladder.
// =====================================================================================================
/** Provenance badge (page.js): live | official | estimated | simulated | illustrative | notshown | unknown | stale. */
export function badge(kind, text = PROV_LABEL[kind], title = PROV_HELP[kind]) {
  return prov(kind, { label: text, title });
}

function liveBadge(asOf) {
  const age = ageDays(asOf);
  if (age != null && age > STALE_DAYS) return badge("stale", `Live · ${fmtDate(asOf)}`, `Real data from ${fmtDate(asOf)}, older than ${STALE_DAYS} days`);
  return badge("live", "Live", `${PROV_HELP.live}: DIVI-Intensivregister, report of ${fmtDate(asOf)}`);
}

function statusPill(tone, label, title = "") {
  return pill(label, tone, { title });
}

/** Freshness for the page head: {badge, text}. */
function freshness(state, asOf) {
  if (state === "ready") return { badge: liveBadge(asOf), text: `DIVI daily report · ${fmtDate(asOf)}` };
  if (state === "loading") return { badge: badge("unknown", "Loading"), text: "DIVI daily report" };
  return { badge: badge("unknown"), text: "DIVI daily report not loaded" };
}

/** 28-day occupancy sparkline. Fixed 60-100% scale in tables so rows compare; auto-scaled in KPI tiles. */
function sparkline(series, { w = 84, h = 22, lo = 60, hi = 100, auto = false, cls = "geo-spark", ref = 85 } = {}) {
  const pts = series.slice(-SPARK_DAYS).filter((d) => d.pct != null);
  if (pts.length < 2) return html`<span class="geo-spark-none">–</span>`;
  if (auto) {
    const ps = pts.map((d) => d.pct);
    lo = Math.floor(Math.min(...ps) - 1);
    hi = Math.ceil(Math.max(...ps) + 1);
  }
  const x = (i) => (i / (pts.length - 1)) * (w - 4) + 2;
  const y = (v) => h - 2 - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo || 1)) * (h - 4);
  const line = pts.map((d, i) => `${x(i).toFixed(1)},${y(d.pct).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  const refLine = ref > lo && ref < hi ? html`<line class="geo-spark-ref" x1="0" x2="${w}" y1="${y(ref).toFixed(1)}" y2="${y(ref).toFixed(1)}"/>` : "";
  const label = `Occupancy over the last ${pts.length} days, from ${fmtPct(pts[0].pct)} to ${fmtPct(last.pct)}`;
  return html`<svg class="${cls}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${label}">
    <title>${label}</title>${refLine}
    <polyline class="geo-spark-line" points="${line}" vector-effect="non-scaling-stroke"/>
    <circle class="geo-spark-dot" cx="${x(pts.length - 1).toFixed(1)}" cy="${y(last.pct).toFixed(1)}" r="2.2"/>
  </svg>`;
}

/** Occupancy bar with thin ticks at 85% and 90%. */
function occBar(p, label) {
  const w = p == null ? 0 : Math.max(0, Math.min(100, p));
  return html`<div class="geo-pct">
    <div class="geo-bar" role="img" aria-label="${label}: ${fmtPct(p)} occupied">
      <i class="is-s${seqStep(p)}" style="width:${w.toFixed(1)}%"></i><b style="left:85%"></b><b style="left:90%"></b>
    </div>
    <span>${fmtPct(p)}</span>
  </div>`;
}

/** Areas that answered = all reporting areas minus those that gave no operating status. */
function staffFigures(f) {
  const answered = f.areas != null && f.noStatement != null ? f.areas - f.noStatement : null;
  const share = answered && f.staff != null ? (100 * f.staff) / answered : null;
  return { answered, share };
}

function staffSegments(f) {
  const { answered } = staffFigures(f);
  if (answered == null || f.staff == null || !f.areas) return "";
  const seg = (n) => ((100 * n) / f.areas).toFixed(2);
  const ok = answered - f.staff;
  const label = `${f.staff} staff-limited, ${ok} answered without a staff limit, ${f.noStatement} no statement, of ${f.areas} reporting areas`;
  return html`<div class="geo-segs" role="img" aria-label="${label}" title="${label}">
    <i class="is-staff" style="width:${seg(f.staff)}%"></i><i class="is-ok" style="width:${seg(ok)}%"></i><i class="is-none" style="width:${seg(f.noStatement)}%"></i>
  </div>
  <div class="geo-segs-key"><span><i class="is-staff"></i>Staff-limited</span><span><i class="is-ok"></i>Not staff-limited</span><span><i class="is-none"></i>No statement ${fmt(f.noStatement)}</span></div>`;
}

const KPI_LABELS = [
  "Adult ICU occupancy",
  "Free ICU beds",
  "7-day emergency reserve",
  "Free invasive ventilation",
  "Areas limited by staff",
];

/** The five KPI slots for an ICU level (Country, City), from one DIVI figure set. */
function icuKpis(f, series, asOf, { alert = false } = {}) {
  const live = liveBadge(asOf);
  const operable = f.occupied != null && f.free != null ? f.occupied + f.free : null;
  const { answered, share } = staffFigures(f);
  const pcts = series.slice(-SPARK_DAYS).map((d) => d.pct).filter((p) => p != null);
  return kpiStrip([
    {
      label: KPI_LABELS[0],
      value: fmtPct(f.pct ?? occPct(f)).replace("%", ""),
      unit: "%",
      detail: `${fmt(f.occupied)} of ${fmt(operable)} operable beds`,
      spark: pcts,
      sparkLabel: pcts.length ? `Occupancy over the last ${pcts.length} days, from ${fmtPct(pcts[0])} to ${fmtPct(pcts.at(-1))}` : "",
      badge: live,
      alert,
    },
    { label: KPI_LABELS[1], value: fmt(f.free), detail: `Operable and staffed now · ${fmt(f.areas)} reporting areas`, badge: live },
    { label: KPI_LABELS[2], value: fmt(f.reserve), detail: "Extra beds that could open within 7 days", badge: live },
    { label: KPI_LABELS[3], value: fmt(f.vent), detail: "Places that can take a ventilated patient now", badge: live },
    {
      label: KPI_LABELS[4],
      value: fmt(f.staff),
      unit: answered == null ? "" : `of ${fmt(answered)} that answered`,
      detail:
        share == null
          ? "Share unknown: no operating status reported"
          : `${share.toFixed(0)}% of answering areas · ${fmt(f.noStatement)} of ${fmt(f.areas)} gave no statement`,
      extra: staffSegments(f),
      badge: live,
    },
  ]);
}

function placeholderKpis(state) {
  const loading = state === "loading";
  return kpiStrip(
    KPI_LABELS.map((label) => ({
      label,
      value: "–",
      detail: loading ? "Loading the DIVI daily report…" : "Not available",
      badge: badge("unknown", loading ? "Loading" : "Unknown"),
    })),
    { busy: loading },
  );
}

function stateCard(state, error) {
  if (state === "loading") {
    return html`<div class="geo-card geo-state" role="status"><p><b>Loading the DIVI daily report…</b></p>
      <p class="geo-muted">The figures appear as soon as the data file has loaded.</p></div>`;
  }
  return html`<div class="geo-card geo-state is-failed" role="alert"><p><b>The DIVI daily report could not be loaded.</b></p>
    <p class="geo-muted">${error || "Check your connection and reload."} Figures stay empty rather than showing 0.</p></div>`;
}

function contextStrip(items, note) {
  return html`<div class="geo-ctx">
    <span class="geo-ctx-k">Context ${badge("official")}</span>
    ${items.map((i) => html`<span title="${i.title ?? ""}">${i.label} <b>${i.value}</b>${i.note ? html` <span class="geo-muted">${i.note}</span>` : ""}</span>`)}
    <span class="geo-muted geo-ctx-note">${note}</span>
  </div>`;
}

function link(url, text) {
  return html`<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
}

/** Sources footer (page.js) from rows {kind, badgeText?, text}. */
function sourcesFooter(rows) {
  return pageSources(rows.map((r) => ({ badge: badge(r.kind, r.badgeText), text: r.text })));
}

function levelsPanel(ctx, levelKey) {
  return sharedLevelsPanel(levelKey, { place: levelKey === "country" ? "Germany" : "Berlin" });
}

// =====================================================================================================
// Country: Germany, the ministry situation desk
// =====================================================================================================
function tileGrid(de) {
  const S = TILE;
  const tiles = de.laender.map((l) => {
    const pos = TILE_POS[l.code];
    if (!pos) return "";
    const [c, r] = pos;
    const st = landStatus(l);
    const step = seqStep(l.pct);
    const isLink = l.code === "BE";
    const x = c * S;
    const y = r * S;
    const label = `${l.name}: ${fmtPct(l.pct)} occupied, ${fmt(l.free)} free, ${fmt(l.reserve)} reserve, ${fmt(l.areas)} reporting areas. ${st.label}.${isLink ? " Open Berlin." : ""}`;
    return html`<g class="geo-tile is-s${step}${st.tone === "crit" ? " is-alert" : ""}${isLink ? " is-link" : ""}" data-land="${l.code}"
      ${isLink ? raw(`data-go="berlin" role="link" tabindex="0" data-focus-key="tile-BE"`) : raw('role="img"')} aria-label="${label}">
      <title>${label}</title>
      <rect class="geo-tile-bg" x="${x + 4}" y="${y + 4}" width="${S - 8}" height="${S - 8}" rx="8"/>
      ${st.tone === "crit" ? html`<rect class="geo-tile-alert" x="${x + 7}" y="${y + 7}" width="${S - 14}" height="${S - 14}" rx="6"/>` : ""}
      <text class="geo-tile-code" x="${x + S / 2}" y="${y + 30}">${l.code}</text>
      <text class="geo-tile-pct" x="${x + S / 2}" y="${y + 49}">${l.pct == null ? "–" : `${l.pct.toFixed(0)}%`}</text>
      <text class="geo-tile-areas" x="${x + S / 2}" y="${y + 65}">${fmt(l.areas)} areas</text>
    </g>`;
  });
  return html`<svg class="geo-tiles" viewBox="0 0 ${S * 5} ${S * 5}" role="group" aria-label="Tile grid of the 16 Länder, coloured by adult ICU occupancy">${tiles}</svg>`;
}

function rampLegend() {
  return html`<div class="geo-legend">
    <div><div class="geo-ramp" aria-hidden="true">${[1, 2, 3, 4, 5].map((s) => html`<i class="is-s${s}"></i>`)}</div>
      <div class="geo-ramp-l"><span>&lt;75</span><span>80</span><span>85</span><span>90+ %</span></div></div>
    ${statusPill("crit", "Alert", "≥90% occupied and <10 free beds for 3 days in a row")}
  </div>`;
}

function clusterSums(de) {
  return Object.entries(KLEEBLATT).map(([name, codes]) => {
    const rows = de.laender.filter((l) => codes.includes(l.code));
    const f = sumFigures(rows);
    return { name, rows, ...f, pct: occPct(f) };
  });
}

function clusterBars(clusters) {
  return html`<div class="geo-kbs"><h3>Kleeblatt clusters</h3>
    ${clusters.map(
      (k) => html`<div class="geo-kbr"><span>${k.name}</span>
        <div class="geo-bar" role="img" aria-label="Kleeblatt ${k.name}: ${fmtPct(k.pct, 0)} occupied"><i class="is-s${seqStep(k.pct)}" style="width:${(k.pct ?? 0).toFixed(1)}%"></i><b style="left:85%"></b><b style="left:90%"></b></div>
        <span>${fmtPct(k.pct, 0)} · ${fmt(k.free)}</span></div>`,
    )}
  </div>`;
}

function landTable(clusters) {
  const rows = clusters.map((k) => {
    const head = html`<tr class="geo-grp"><td colspan="6">Kleeblatt ${k.name} · ${fmtPct(k.pct, 0)} · ${fmt(k.free)} free · ${fmt(k.areas)} reporting areas</td></tr>`;
    const lands = [...k.rows].sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));
    return html`${head}${lands.map((l) => {
      const st = landStatus(l);
      const { answered } = staffFigures(l);
      const isLink = l.code === "BE";
      return html`<tr data-land="${l.code}" class="${isLink ? "is-link" : ""}"${isLink ? raw(' data-go="berlin" tabindex="0" role="link" data-focus-key="row-BE"') : ""}>
        <td><span class="geo-name">${l.name}</span>${st.tone !== "ok" ? html` ${statusPill(st.tone, st.label, st.tone === "crit" ? `${l.streak} days in a row at ≥90% with <10 free` : "")}` : ""}
          <span class="geo-areas">${fmt(l.areas)} reporting areas${isLink ? " · open city view" : ""}</span></td>
        <td>${occBar(l.pct, l.name)}</td>
        <td class="n">${fmt(l.free)}</td>
        <td class="n geo-hide-s">${fmt(l.reserve)}</td>
        <td class="n geo-hide-s" title="${fmt(l.noStatement)} of ${fmt(l.areas)} areas gave no statement">${fmt(l.staff)} <span class="geo-muted">/ ${fmt(answered)}</span></td>
        <td class="geo-hide-s">${sparkline(l.series)}</td>
      </tr>`;
    })}`;
  });
  return html`<div class="geo-table-wrap"><table class="geo-table">
    <caption class="sr-only">Adult ICU capacity per Land, grouped by Kleeblatt cluster, fullest first</caption>
    <thead><tr><th scope="col">Land</th><th scope="col" class="geo-col-occ">ICU occupancy</th><th scope="col" class="n">Free</th>
      <th scope="col" class="n geo-hide-s">Reserve</th><th scope="col" class="n geo-hide-s" title="Areas limited by staff / areas that answered">Staff-limited</th>
      <th scope="col" class="geo-hide-s">28 days</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function alertsCard(de) {
  const alerts = de.laender.filter((l) => landStatus(l).tone === "crit").sort((a, b) => b.pct - a.pct);
  const watch = de.laender.filter((l) => landStatus(l).tone === "warn").sort((a, b) => b.pct - a.pct);
  const clusterFree = (l) =>
    de.laender.filter((x) => x.cluster === l.cluster && x.code !== l.code).reduce((n, x) => n + (x.free ?? 0), 0);
  const items = [
    ...alerts.map(
      (l) => html`<li>
        <div class="geo-li-top"><span class="geo-from">${l.name} · Kleeblatt ${l.cluster} · ${fmt(l.areas)} reporting areas</span>${statusPill("crit", "Alert")}</div>
        <div class="geo-what">${fmtPct(l.pct)} occupied, ${fmt(l.free)} free ICU beds</div>
        <div class="geo-why">At ≥90% with fewer than 10 free beds for ${l.streak >= l.series.length ? "at least " : ""}${plural(l.streak, "day")} in a row. The other Länder in Kleeblatt ${l.cluster} have ${fmt(clusterFree(l))} free beds. Suggested: ask the Kleeblatt ${l.cluster} contact point to prepare transfers.</div>
      </li>`,
    ),
    ...watch.map((l) => {
      const why =
        l.streak > 0
          ? `Meets the alert rule today (day ${l.streak} of ${ALERT_RULE.days}).`
          : l.free < ALERT_RULE.free
            ? `Under ${ALERT_RULE.free} free beds, below ${ALERT_RULE.pct}% occupied.`
            : `At or above ${WATCH_PCT}% occupied, ${fmt(l.free)} free.`;
      return html`<li>
        <div class="geo-li-top"><span class="geo-from">${l.name} · Kleeblatt ${l.cluster} · ${fmt(l.areas)} reporting areas</span>${statusPill("warn", "Watch")}</div>
        <div class="geo-what">${fmtPct(l.pct)} occupied, ${fmt(l.free)} free ICU beds</div>
        <div class="geo-why">${why} No alert yet: small Länder swing from day to day.</div>
      </li>`;
    }),
    html`<li>
      <div class="geo-li-top"><span class="geo-from">Netherlands · national coordination centre</span>${badge("illustrative")}</div>
      <div class="geo-what">Request: 2 adult burn-ICU beds within 24 h</div>
      <div class="geo-why">Shared: number of patients, care level needed, time window. Not shared: who the patients are. Shows how an EU request would arrive; no real feed.</div>
    </li>`,
  ];
  return html`<section class="geo-card geo-alerts" aria-labelledby="geo-alerts-title">
    <header class="geo-card-head"><div><h2 id="geo-alerts-title">Alerts &amp; requests</h2>
      <p>Alert when a Land is ≥${ALERT_RULE.pct}% occupied AND has &lt;${ALERT_RULE.free} free beds, ${ALERT_RULE.days} days in a row.</p></div></header>
    ${alerts.length ? "" : html`<p class="geo-empty">No Land meets the alert rule on ${fmtDate(de.asOf)}.</p>`}
    <ul class="geo-list">${items}</ul>
  </section>`;
}

function perSiteCard() {
  return html`<section class="geo-card" aria-labelledby="geo-site-title">
    <header class="geo-card-head"><div><h2 id="geo-site-title">Per-site ICU status</h2><p>Low care, high care, ECMO per hospital site</p></div>${badge("notshown")}</header>
    <div class="geo-body">
      <p>Exists, not shown (licence pending). Hospitals report every site to the DIVI-Intensivregister (IfSG §13(7)), and ${link(DIVI_SITES_URL, "intensivregister.de")} publishes the status per site. It appears here once DIVI and the RKI confirm the licence.</p>
      <p class="geo-muted">This is a licence question, not a legal lock: the federal level and the public already see this layer.</p>
    </div>
  </section>`;
}

const NEIGHBOURS = [
  ["AT", "Austria", true],
  ["BE", "Belgium", true],
  ["LU", "Luxembourg", true],
  ["NL", "Netherlands", false],
  ["FR", "France", false],
  ["CH", "Switzerland", false],
  ["CZ", "Czechia", false],
  ["PL", "Poland", false],
  ["DK", "Denmark", false],
];

function neighboursCard() {
  const group = (sari) => NEIGHBOURS.filter((n) => n[2] === sari);
  const chips = (list) => html`<span class="geo-ccs">${list.map(([cc, name]) => html`<abbr class="geo-cc" title="${name}">${cc}</abbr>`)}</span>`;
  return html`<section class="geo-card" aria-labelledby="geo-nb-title">
    <header class="geo-card-head"><div><h2 id="geo-nb-title">Shared with me</h2><p>Neighbouring countries' pressure band</p></div>${badge("illustrative")}</header>
    <ul class="geo-nbs">
      <li>${chips(group(true))}<span>Weekly SARI feed exists (ECDC ERVISS)<small>${group(true).map((n) => n[1]).join(", ")}</small></span>
        ${statusPill("mute", "Band in the EU step", "The feed exists; the band arrives with the EU layer")}</li>
      <li>${chips(group(false))}<span>Not in ECDC ERVISS<small>${group(false).map((n) => n[1]).join(", ")}</small></span>${statusPill("mute", "No SARI feed")}</li>
    </ul>
    <div class="geo-card-foot"><span>No live cross-border ICU feed exists today. A band will compare a country only with its own past seasons, never rank countries.</span></div>
  </section>`;
}

function sharedByMeCard(de) {
  return html`<section class="geo-card" aria-labelledby="geo-sbm-title">
    <header class="geo-card-head"><div><h2 id="geo-sbm-title">Shared by me</h2><p>What Germany passes on, and how often</p></div></header>
    <div class="geo-body">
      <dl class="geo-kv">
        <dt>To the public: Länder ICU totals (${fmt(de.total.free)} free today)</dt><dd>Daily ${badge("live")}</dd>
        <dt>To other Länder: Kleeblatt offers and needs via the GMLZ</dt><dd>On request ${badge("illustrative")}</dd>
        <dt>To the EU (HSC, EWRS): alerts; ICU places requested or offered</dt><dd>Within 24 h ${badge("illustrative")}</dd>
        <dt>To WHO: events (IHR Art. 6) and yearly SPAR; weekly indicators only in a declared emergency</dt><dd>Events, yearly ${badge("illustrative")}</dd>
      </dl>
      <div class="geo-never"><b>Never shared:</b> patient identities, hospital clinical details, critical-infrastructure security data.</div>
    </div>
  </section>`;
}

function germanySources(state, de) {
  const date = de ? `daily report of ${fmtDate(de.asOf)}` : "daily report (not loaded)";
  return sourcesFooter([
    {
      kind: state === "ready" ? "live" : "unknown",
      badgeText: state === "ready" ? "Live" : "Unknown",
      text: html`ICU figures: ${DIVI.name}, adults, ${date}. ${DIVI.publisher} open data, ${link(de?.source.url ?? DIVI.url, "github.com/robert-koch-institut")}, ${de?.source.licence ?? DIVI.licence}.`,
    },
    {
      kind: "official",
      text: html`Hospitals and beds: ${link(DESTATIS.url, DESTATIS.name)}, ${DESTATIS.licence}. Beds per 1,000 people: ${link(WB_BEDS.url, WB_BEDS.name)}, ${WB_BEDS.year}, ${WB_BEDS.licence}.`,
    },
    {
      kind: "notshown",
      text: html`Per-site ICU status: ${link(DIVI_SITES_URL, "intensivregister.de")}, no stated licence yet.`,
    },
    {
      kind: "illustrative",
      text: "Neighbour bands, the cross-border request and the flows to the EU and WHO show how they would work; no real feed behind them.",
    },
  ]);
}

function germanyPage(ctx) {
  const { state, de, error } = realDE(ctx);
  const clusters = de ? clusterSums(de) : null;
  const alerts = de ? de.laender.filter((l) => landStatus(l).tone === "crit") : [];
  const rule = `Alert: ≥${ALERT_RULE.pct}% occupied and <${ALERT_RULE.free} free beds for ${ALERT_RULE.days} days in a row`;
  const status =
    state !== "ready"
      ? null
      : alerts.length
        ? { text: `${plural(alerts.length, "Land", "Länder")} on alert`, tone: "crit", title: rule }
        : { text: "No Land on alert", tone: "ok", title: rule };
  const headHtml = pageHead({
    level: "Country",
    place: "Germany · ministry situation desk",
    title: "Adult intensive care capacity",
    question: "Is there intensive care capacity where it will be needed, and which Land needs help?",
    sees: "Länder totals by default; per-site ICU status as published by DIVI.",
    status,
    fresh: freshness(state, de?.asOf),
  });
  const ctxHtml = contextStrip(
    [
      ...CONTEXT_DE.map((c) => ({ ...c, title: `${DESTATIS.name}, ${DESTATIS.licence}` })),
      { label: "Beds per 1,000 people", value: WB_BEDS.value, note: `(${WB_BEDS.year})`, title: `${WB_BEDS.name}, ${WB_BEDS.licence}` },
    ],
    "Destatis 2024, World Bank 2023. Annual, not live: they put the ICU numbers in proportion.",
  );

  if (state !== "ready") {
    return html`<div class="pg geo-page geo-de">
      ${headHtml}${placeholderKpis(state)}${ctxHtml}${stateCard(state, error)}
      <div class="geo-grid"><div class="geo-stack">${perSiteCard()}</div><aside class="geo-rail">${neighboursCard()}</aside></div>
      ${levelsPanel(ctx, "country")}${germanySources(state, null)}
    </div>`;
  }

  const t = de.total;
  return html`<div class="pg geo-page geo-de">
    ${headHtml}
    ${icuKpis(t, t.series, de.asOf, { alert: t.pct != null && t.pct >= ALERT_RULE.pct })}
    ${ctxHtml}
    <div class="geo-grid">
      <div class="geo-stack">
        <section class="geo-card geo-laender" aria-labelledby="geo-laender-title">
          <header class="geo-card-head"><div><h2 id="geo-laender-title">Länder</h2>
            <p>Grouped by Kleeblatt cluster, fullest first. Thin marks on each bar: 85% and 90% occupancy. Berlin opens its city view.</p></div>
            ${liveBadge(de.asOf)}</header>
          <div class="geo-two">
            <div class="geo-mapcol">
              ${tileGrid(de)}
              ${rampLegend()}
              <p class="geo-muted geo-tiles-note">Equal tiles on purpose: Bremen counts as much as Bayern when it runs full.</p>
              ${clusterBars(clusters)}
            </div>
            ${landTable(clusters)}
          </div>
          <div class="geo-card-foot">
            <span>Coverage: ${fmt(t.areas)} adult reporting areas reported on ${fmtDate(de.asOf)}; not every ICU reports every day.</span>
            <span>Kleeblatt = the five clusters the Länder use to move ICU patients between each other.</span>
          </div>
        </section>
        ${perSiteCard()}
      </div>
      <aside class="geo-rail" aria-label="Alerts and sharing">
        ${alertsCard(de)}
        ${sharedByMeCard(de)}
        ${neighboursCard()}
      </aside>
    </div>
    ${levelsPanel(ctx, "country")}
    ${germanySources(state, de)}
  </div>`;
}

// =====================================================================================================
// City: Berlin. Real DIVI header; the fictional demo twins in their own, labelled block.
// =====================================================================================================
function demoBlock(snap, net) {
  const icuBeds = sum(net.hospitals, (h) => h.units.ICU.bedsStaffed);
  const icuUsed = sum(net.hospitals, (h) => h.units.ICU.bedsOccupied);
  return html`<section class="geo-card geo-demo" aria-labelledby="geo-demo-title">
    <header class="geo-card-head">
      <div><h2 id="geo-demo-title">Demo twins (simulated)</h2>
        <p>${plural(net.count, "fictional hospital")} run by the seeded simulation. Not part of the DIVI figures above, and never added to them.</p></div>
      ${badge("simulated", `Simulated · seed ${snap.seed}`)}
    </header>
    <div class="geo-demo-stats">
      <div><span class="geo-demo-v">${net.freeICU}</span><span class="geo-demo-l">ICU beds free</span></div>
      <div><span class="geo-demo-v">${icuUsed}<small> / ${icuBeds}</small></span><span class="geo-demo-l">ICU beds in use</span></div>
      <div><span class="geo-demo-v">${net.freeWard}</span><span class="geo-demo-l">Ward beds free</span></div>
      <div><span class="geo-demo-v">${net.inUse}<small> / ${net.beds}</small></span><span class="geo-demo-l">Beds in use, all units</span></div>
      ${snap.surge ? html`<div class="geo-demo-surge">${emergencyChip(snap)}</div>` : ""}
    </div>
  </section>`;
}

function berlinSources(state, de, snap) {
  const date = de ? `daily report of ${fmtDate(de.asOf)}` : "daily report (not loaded)";
  return sourcesFooter([
    {
      kind: state === "ready" ? "live" : "unknown",
      badgeText: state === "ready" ? "Live" : "Unknown",
      text: html`ICU figures for Berlin: ${DIVI.name}, adults, ${date}. ${DIVI.publisher} open data, ${link(de?.source.url ?? DIVI.url, "github.com/robert-koch-institut")}, ${de?.source.licence ?? DIVI.licence}.`,
    },
    {
      kind: "official",
      text: html`Planned beds: ${link(BERLIN_PLAN.url, BERLIN_PLAN.name)}, ${BERLIN_PLAN.licence}. Set-up beds: ${link(BERLIN_STAT.url, BERLIN_STAT.name)}, ${BERLIN_STAT.licence}.`,
    },
    {
      kind: "simulated",
      text: `Demo twins: three fictional hospitals and their patients, simulated with seed ${snap.seed}. Their positions on the map are illustrative.`,
    },
    {
      kind: "official",
      text: "Map: Berlin districts from Berliner Morgenpost Berlin-Geodaten (CC BY, Amt für Statistik Berlin-Brandenburg).",
    },
  ]);
}

function berlinPage(snap, net, ctx) {
  const { state, de, error } = realDE(ctx);
  const be = de?.laender.find((l) => l.code === "BE");
  const st = be ? landStatus(be) : null;
  const headHtml = pageHead({
    level: "City",
    place: "Berlin · Land and City (city-state)",
    title: "Intensive care capacity in Berlin",
    question: "Can Berlin's intensive care units take more patients today?",
    sees: "Real DIVI totals for Berlin; exact counts per hospital and capability in the authority tier. The hospitals on the map are fictional demo twins, simulated separately.",
    status: st
      ? {
          text: st.tone === "ok" ? "Normal" : st.label,
          tone: st.tone,
          title: `Alert rule: ≥${ALERT_RULE.pct}% occupied and <${ALERT_RULE.free} free for ${ALERT_RULE.days} days`,
        }
      : null,
    fresh: freshness(be ? state : state === "ready" ? "failed" : state, de?.asOf),
  });
  const kpis = be ? icuKpis(be, be.series, de.asOf) : placeholderKpis(state === "ready" ? "failed" : state);
  const stage = libsReady(3) ? berlinMap(snap, net, ctx) : missingCard();
  return html`<div class="pg geo-page geo-be">
    ${headHtml}
    ${kpis}
    ${be ? "" : state === "ready" ? stateCard("failed", "Berlin is missing from the data file.") : stateCard(state, error)}
    ${contextStrip(
      [
        { label: "Planned beds", value: BERLIN_PLAN.value, note: `${BERLIN_PLAN.sites} plan hospitals`, title: `${BERLIN_PLAN.name}, ${BERLIN_PLAN.licence}` },
        { label: "Set-up beds", value: BERLIN_STAT.value, note: `${BERLIN_STAT.hospitals} hospitals, ${BERLIN_STAT.year}`, title: `${BERLIN_STAT.name}, ${BERLIN_STAT.licence}` },
      ],
      "Planned beds are what the hospital plan allows; set-up beds are what was actually in place.",
    )}
    ${demoBlock(snap, net)}
    <div class="layout map-layout">
      <section class="stage" aria-label="Map of the demo twins">${stage}</section>
      <aside class="panel" aria-label="Demo twins in Berlin">${berlinPanel(snap, net, ctx)}</aside>
    </div>
    ${levelsPanel(ctx, "city")}
    ${berlinSources(state, de, snap)}
  </div>`;
}

// -- focus: a re-render every simulated hour must not throw the keyboard user out ---------------
function focusedKey(container) {
  if (typeof document === "undefined" || typeof container.contains !== "function") return null;
  const el = document.activeElement;
  return el && container.contains(el) ? el.getAttribute("data-focus-key") : null;
}

function restoreFocus(container, key) {
  if (!key || typeof container.querySelector !== "function") return;
  const el = container.querySelector(`[data-focus-key="${key}"]`);
  if (el) el.focus({ preventScroll: true });
}

// Linked hover on the Germany page: a tile and its table row light up together.
function linkHover(container, on) {
  const handler = (event) => {
    const land = on && event.type === "mouseover" ? event.target.closest?.("[data-land]")?.dataset.land : null;
    for (const el of container.querySelectorAll(".is-hl")) if (el.dataset.land !== land) el.classList.remove("is-hl");
    if (land) for (const el of container.querySelectorAll(`[data-land="${land}"]`)) el.classList.add("is-hl");
  };
  container.onmouseover = on ? handler : null;
  container.onmouseleave = on ? handler : null;
}

function pageOf(route) {
  if (route.token === "germany" || route.page === "germany") return "germany";
  if (route.token === "berlin" || route.page === "berlin") return "berlin";
  return route.level === 3 ? "berlin" : "germany";
}

// -- entry point -----------------------------------------------------------------------------------
export function render(container, ctx) {
  const page = pageOf(ctx.route);
  const { snap } = ctx;
  const net = networkStats(snap);
  const key = focusedKey(container);
  linkHover(container, page === "germany");
  const out = page === "germany" ? germanyPage(ctx) : berlinPage(snap, net, ctx);
  container.innerHTML = String(out);
  restoreFocus(container, key);
}
