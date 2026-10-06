// The three map levels of the twin: Earth (1), Germany (2) and Berlin (3).
// d3 and topojson are globals from index.html. The projected base maps are built once per
// level and cached; each render only redraws the live overlays (pins, rings, numbers).

import berlinGeo from "../data/berlin.js";
import germanyGeo from "../data/germany.js";
import { BERLIN, HOSPITAL_BY_ID, HOSPITALS, OTHER_CITIES, OWN_HOSPITAL } from "../data/places.js";
import worldTopo from "../data/world.js";
import { chip, confBar, esc, html, meter, pct, plural, raw, UTIL_LABEL, utilTone } from "./dom.js";

// Equal Earth is about 2.05:1, so the world viewBox is a little flatter than 16:9.
const VIEWBOX = { 1: [960, 480], 2: [640, 760], 3: [960, 640] };
const EARTH_KM = "12,742 km";
const GERMANY_KM = "876 km north–south";
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

function worstChip(net) {
  const h = net.worstHospital;
  if (!h) return "";
  return chip(`${UTIL_LABEL[h.tone]}: ${h.place?.short ?? h.name} ${h.worstUnit} ${pct(h.worst)} in use`, h.tone, {
    title: "The fullest ICU or Ward in the network",
  });
}

function stat(value, label) {
  return html`<div class="stat"><span class="stat-value">${value}</span><span class="stat-label">${label}</span></div>`;
}

function head({ eyebrow, title, lede, chips }) {
  return html`<div class="view-head">
    <div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${lede}</p></div>
    <div class="row">${chips}</div>
  </div>`;
}

function libsReady(level) {
  const { d3, topojson } = globalThis;
  if (!d3 || typeof d3.geoPath !== "function") return false;
  return level !== 1 || Boolean(topojson && typeof topojson.feature === "function");
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

function buildEarth() {
  const { d3, topojson } = globalThis;
  const [w, h] = VIEWBOX[1];
  const sphere = { type: "Sphere" };
  const projection = d3.geoEqualEarth().fitExtent(
    [
      [10, 10],
      [w - 10, h - 10],
    ],
    sphere,
  );
  const path = geoPath(projection);
  const countries = topojson.feature(worldTopo, worldTopo.objects.countries);
  const de = countries.features.find((f) => String(f.id) === "276");
  // Merged land plus a border mesh is about half the markup of 177 country outlines.
  const land = topojson.feature(worldTopo, worldTopo.objects.land);
  const borders = topojson.mesh(worldTopo, worldTopo.objects.countries, (a, b) => a !== b);
  const graticule = d3.geoGraticule().step([20, 20]);
  const base = `
    <path class="map-sphere" d="${path(sphere)}"/>
    <path class="map-graticule" fill="none" d="${path(graticule())}"/>
    <path class="map-land" d="${path(land)}"/>
    <path class="map-borders" fill="none" d="${path(borders)}"/>`;
  return { base, germany: path(de), centroid: path.centroid(de), berlin: projection([BERLIN.lon, BERLIN.lat]) };
}

function buildGermany() {
  const { d3 } = globalThis;
  const [w, h] = VIEWBOX[2];
  const projection = d3.geoMercator().fitExtent(
    [
      [24, 24],
      [w - 24, h - 24],
    ],
    germanyGeo,
  );
  const path = geoPath(projection);
  const be = germanyGeo.features.find((f) => f.properties.id === "DE-BE");
  const states = germanyGeo.features
    .filter((f) => f !== be)
    .map((f) => `<path class="map-state" d="${path(f)}"><title>${esc(f.properties.name)}</title></path>`)
    .join("");
  const cities = OTHER_CITIES.map((c) => {
    const [x, y] = projection([c.lon, c.lat]);
    return `<g class="map-city"><title>${esc(c.name)}: not connected yet</title>
      <circle class="map-city-dot" cx="${f1(x)}" cy="${f1(y)}" r="3.5"/>
      <text class="map-city-label" x="${f1(x + 7)}" y="${f1(y)}" dy="0.35em">${esc(c.name)}</text></g>`;
  }).join("");
  const bar = kmToUnits(projection, 10.45, 51.2, 100);
  const base = `
    <rect class="map-water" x="0" y="0" width="${w}" height="${h}"/>
    ${states}
    ${cities}
    ${scaleBar(24, h - 24, bar, "100 km")}`;
  return { base, berlinState: path(be), berlin: projection([BERLIN.lon, BERLIN.lat]) };
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

const BUILDERS = { 1: buildEarth, 2: buildGermany, 3: buildBerlin };

// -- the map cards ----------------------------------------------------------------------------
function missingCard() {
  return html`<div class="card map-missing" role="alert">
    <p>The map library didn't load. Check your connection and reload.</p>
  </div>`;
}

function svg(level, label, content) {
  const [w, h] = VIEWBOX[level];
  const cls = { 1: "earth", 2: "germany", 3: "berlin" }[level];
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

function earthMap(snap, net, ctx) {
  const m = baseMap(1);
  const [bx, by] = m.berlin;
  const [cx, cy] = m.centroid;
  const overlay = html`
    <g class="map-hit" data-go="${ctx.routes.germany}" role="link" tabindex="0" data-focus-key="earth-germany"
      aria-label="Germany, ${net.count} hospitals in Berlin. Zoom in.">
      <title>Germany: zoom in</title>
      <circle class="map-hit-area" cx="${f1(cx)}" cy="${f1(cy)}" r="34"/>
      <circle class="map-focus" cx="${f1(cx)}" cy="${f1(cy)}" r="26"/>
      <circle class="map-target-ring" cx="${f1(cx)}" cy="${f1(cy)}" r="19"/>
      <path class="map-de" d="${m.germany}"/>
      <circle class="map-pulse${snap.surge ? " is-crit" : ""}" cx="${f1(bx)}" cy="${f1(by)}" r="6" style="${phase(PULSE_MS)}"/>
      <circle class="map-marker" cx="${f1(bx)}" cy="${f1(by)}" r="3"/>
      ${svgText("map-label", bx + 30, by, "start", [
        { cls: "map-label-name", dy: "-0.15em", text: "Germany" },
        { cls: "map-label-detail", dy: "1.3em", text: `${plural(net.count, "hospital")} in Berlin` },
      ])}
    </g>`;
  return html`<div class="card card-flush map-card map-card-earth">
    ${svg(1, "World map. Germany is highlighted; select it to zoom in.", html`${raw(m.base)}${overlay}`)}
    <div class="map-foot">
      <div class="legend">
        <span><i class="swatch map-sw-active"></i>Connected: Germany</span>
        <span><i class="swatch map-sw-ring"></i>Berlin, where the ${plural(net.count, "hospital")} are</span>
      </div>
      <span class="faint">Select Germany to zoom in.</span>
    </div>
  </div>`;
}

function germanyMap(snap, net, ctx) {
  const m = baseMap(2);
  const [bx, by] = m.berlin;
  const lx = bx - 38;
  const overlay = html`
    <g class="map-hit" data-go="${ctx.routes.berlin}" role="link" tabindex="0" data-focus-key="germany-berlin"
      aria-label="Berlin, ${net.count} hospitals: ICU ${net.freeICU} free, Ward ${net.freeWard} free. Open Berlin.">
      <title>Berlin: open the city map</title>
      <circle class="map-hit-area" cx="${f1(bx)}" cy="${f1(by)}" r="40"/>
      <path class="map-be" d="${m.berlinState}"/>
      ${snap.surge ? html`<circle class="map-pulse is-crit" cx="${f1(bx)}" cy="${f1(by)}" r="22" style="${phase(PULSE_MS)}"/>` : ""}
      <circle class="map-ring is-${net.worstTone}" cx="${f1(bx)}" cy="${f1(by)}" r="27"/>
      <circle class="map-focus" cx="${f1(bx)}" cy="${f1(by)}" r="33"/>
      <circle class="map-marker" cx="${f1(bx)}" cy="${f1(by)}" r="3.5"/>
      ${svgText("map-label map-label-berlin", lx, by, "end", [
        { cls: "map-label-name", dy: "-0.4em", text: "Berlin" },
        { cls: "map-label-detail", dy: "1.35em", text: plural(net.count, "hospital") },
        { cls: "map-label-detail", dy: "1.25em", text: `ICU ${net.freeICU} free · Ward ${net.freeWard} free` },
      ])}
    </g>`;
  return html`<div class="card card-flush map-card map-card-germany">
    ${svg(2, "Map of Germany's 16 states. Berlin is highlighted; select it to open the city map.", html`${raw(m.base)}${overlay}`)}
    <div class="map-foot">
      <div class="legend">
        <span><i class="swatch map-sw-active"></i>Connected: Berlin</span>
        <span><i class="swatch map-sw-city"></i>Not connected yet</span>
        <span><i class="swatch map-sw-ring-tone is-${net.worstTone}"></i>Ring: fullest ICU or Ward in the network</span>
      </div>
      <span class="faint">Select Berlin to zoom in.</span>
    </div>
  </div>`;
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
    ${svg(3, "Map of Berlin's 12 districts with the network's hospitals. Select a hospital to open it.", html`${raw(m.base)}${links}${pins}`)}
    <div class="map-foot">
      <div class="legend">
        <span><i class="swatch map-sw-tone is-ok"></i>Up to 85% in use</span>
        <span><i class="swatch map-sw-tone is-warn"></i>85–95%</span>
        <span><i class="swatch map-sw-tone is-crit"></i>Over 95%</span>
        <span><i class="swatch map-sw-own"></i>Ours</span>
        <span><i class="swatch map-sw-link"></i>Latest capacity report</span>
      </div>
      <span class="faint">Pin size: total beds. Colour: the fuller of ICU and Ward.</span>
    </div>
  </div>`;
}

const MAPS = { 1: earthMap, 2: germanyMap, 3: berlinMap };

// -- panels ------------------------------------------------------------------------------------
function earthPanel(snap, net, ctx) {
  const own = net.hospitals.find((h) => h.isOwn);
  const levels = [
    { n: 1, name: "Earth", scale: EARTH_KM, shows: "Where the network is.", token: ctx.routes.earth },
    { n: 2, name: "Germany", scale: GERMANY_KM, shows: "Which regions are connected.", token: ctx.routes.germany },
    {
      n: 3,
      name: "Berlin",
      scale: `${BERLIN.areaKm2} km²`,
      shows: "Every hospital's free beds and what it can accept.",
      token: ctx.routes.berlin,
    },
    {
      n: 4,
      name: "Hospital",
      scale: `${own ? own.beds : 0} beds`,
      shows: "The bed board, the plan for the next hour and the team conversation.",
      token: ctx.routes.hospital(OWN_HOSPITAL.id),
    },
    {
      n: 5,
      name: "Unit",
      scale: `${snap.units.ICU.bedsTotal} beds`,
      shows: "Occupancy over the day, the queue and every patient.",
      token: ctx.routes.unit("ICU"),
    },
  ];
  return html`
    <div class="card map-summary">
      <div><div class="eyebrow">The network</div><h3>${plural(net.count, "hospital")} in Berlin</h3></div>
      <div class="map-stats">
        ${stat(net.beds, "beds in total")}
        ${stat(net.inUse, "in use now")}
        ${stat(net.freeICU, "ICU beds free")}
        ${stat(net.freeWard, "Ward beds free")}
      </div>
      ${snap.surge ? html`<div class="row">${emergencyChip(snap)}</div>` : ""}
      <div class="row">
        <a class="btn btn-primary" href="#${ctx.routes.germany}" data-focus-key="earth-zoom">Zoom to Germany</a>
      </div>
    </div>
    <div class="card">
      <div class="eyebrow">Five levels, one twin</div>
      <ol class="map-levels">
        ${levels.map(
          (l) => html`<li>
            <a href="#${l.token}"${l.n === 1 ? raw(' aria-current="page"') : ""} data-focus-key="level-${l.n}">
              <span class="map-lvl-num">${l.n}</span>
              <span class="map-lvl-title"><span>${l.name}</span><span class="map-lvl-scale">${l.scale}</span></span>
              <span class="map-lvl-shows">${l.shows}</span>
            </a>
          </li>`,
        )}
      </ol>
    </div>`;
}

function germanyPanel(snap, net, ctx) {
  return html`
    <div class="card map-summary">
      <div><div class="eyebrow">Connected region</div><h3>Berlin</h3></div>
      <p class="muted">${plural(net.count, "hospital")} report their free beds to the Regional coordinator every hour.</p>
      <div class="map-stats">${stat(net.freeICU, "ICU beds free")} ${stat(net.freeWard, "Ward beds free")}</div>
      <div class="row">${worstChip(net)} ${emergencyChip(snap)}</div>
      <div class="row">
        <a class="btn btn-primary" href="#${ctx.routes.berlin}" data-focus-key="germany-open">Open Berlin</a>
      </div>
    </div>
    <div class="card">
      <div class="eyebrow">Not connected yet</div>
      <ul class="map-cities">
        ${OTHER_CITIES.map((c) => html`<li><span class="map-city-mark" aria-hidden="true"></span>${c.name}</li>`)}
      </ul>
      <p class="faint map-note">Shown for orientation only. No hospital there sends data to the twin.</p>
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
      ${h.isOwn ? chip("ours", "accent", { plain: true }) : ""}
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

// -- heads --------------------------------------------------------------------------------------
function headFor(level, snap, net) {
  if (level === 2) {
    return head({
      eyebrow: "Level 2 of 5 · Germany",
      title: "Which regions are connected",
      lede: "Berlin is the only region in the network so far. Select it to see its hospitals.",
      chips: html`${chip("1 region connected", "accent")}
      ${chip(`${OTHER_CITIES.length} cities not connected yet`, "", { plain: true })} ${worstChip(net)} ${emergencyChip(snap)}`,
    });
  }
  if (level === 3) {
    return head({
      eyebrow: "Level 3 of 5 · Berlin",
      title: "Free beds across Berlin",
      lede: "Each pin is a hospital, sized by its beds and coloured by how full its ICU or Ward is. The dashed lines show what each neighbour told the Regional coordinator it can accept. Select a hospital to open it.",
      chips: html`${chip(`ICU ${net.freeICU} free`, net.icuTone)} ${chip(`Ward ${net.freeWard} free`, net.wardTone)}
      ${worstChip(net)} ${emergencyChip(snap)}`,
    });
  }
  return head({
    eyebrow: "Level 1 of 5 · Earth",
    title: "Where the network is",
    lede: `A digital twin of ${plural(net.count, "hospital")} in Berlin, simulated hour by hour, from the whole planet down to a single bed. Select Germany to zoom in.`,
    chips: html`${chip(plural(net.count, "hospital"), "accent")} ${chip(`ICU ${net.freeICU} free`, net.icuTone)} ${emergencyChip(snap)}`,
  });
}

const PANELS = { 1: earthPanel, 2: germanyPanel, 3: berlinPanel };
const PANEL_LABEL = { 1: "The network", 2: "Connected regions", 3: "Hospitals in Berlin" };

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

// -- entry point -----------------------------------------------------------------------------------
export function render(container, ctx) {
  const level = [1, 2, 3].includes(ctx.route.level) ? ctx.route.level : 1;
  const { snap } = ctx;
  const net = networkStats(snap);
  const key = focusedKey(container);
  const stage = libsReady(level) ? MAPS[level](snap, net, ctx) : missingCard();
  container.innerHTML = String(html`
    ${headFor(level, snap, net)}
    <div class="layout map-layout">
      <section class="stage" aria-label="Map">${stage}</section>
      <aside class="panel" aria-label="${PANEL_LABEL[level]}">${PANELS[level](snap, net, ctx)}</aside>
    </div>
  `);
  restoreFocus(container, key);
}
