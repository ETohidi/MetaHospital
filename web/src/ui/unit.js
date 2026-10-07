// Unit level: one unit of our own hospital (ED, ICU or Ward), the charge nurse's screen.
// Same anatomy as the hospital page: head, KPI strip, main column (beds, charts, patients),
// rail (the plan decision, what the unit shares, what it gets), levels panel and sources.

import { OWN_HOSPITAL, UNITS, UNIT_LABEL } from "../data/places.js";
import { clock, dayClock, DAY_START } from "../engine/clock.js";
import { ACUITY_LABEL, acuity, confBar, html, plural, raw, utilTone } from "./dom.js";
import {
  bedBoard,
  capabilityStatus,
  handleBedClick,
  handleDecisionClick,
  onDraftEdit,
  onRejectSubmit,
  requestsCard,
  utilStatus,
} from "./hospital.js";
import { levelsPanel } from "./levels.js";
import { kpiStrip, pageHead, pill, prov, simBadge, sourcesFooter } from "./page.js";

const CONDITION_ORDER = ["trauma", "cardiac", "respiratory", "stroke", "infection", "other"];
const HISTORY_WINDOW = 24; // hours of history drawn; older hours scroll off the left
const TIP_CHAR_W = 6.6; // rough width of one 11px tabular-figure character, for sizing tooltip boxes

const UNIT_ROLE = {
  ED: "Takes every new arrival, stabilises them and moves those who need a bed upstairs to Intensive Care or the ward.",
  ICU: "Cares for the sickest patients, mostly acuity 4 and 5, until they are stable enough for the ward.",
  Ward: "Cares for patients who are stable but still need a bed, until they can go home.",
};

const PLAN_TONE = { approved: "ok", rejected: "crit", expired: "mute", pending: "warn" };
const PLAN_LABEL = { approved: "Approved", rejected: "Rejected", expired: "Expired", pending: "Waiting" };

// -- time formatting ---------------------------------------------------------------
const dayOf = (tick) => Math.floor((DAY_START.hour + tick) / 24);

/** Wall-clock time of a tick, with the day when it isn't today. */
function when(tick, now) {
  const diff = dayOf(tick) - dayOf(now);
  if (diff === 0) return clock(tick);
  if (diff === 1) return `tomorrow ${clock(tick)}`;
  if (diff === -1) return `yesterday ${clock(tick)}`;
  return dayClock(tick);
}

/** Hour label for the hourly table: the clock time, with the day when it isn't today. */
function hourLabel(tick, now) {
  return dayOf(tick) === dayOf(now) ? clock(tick) : when(tick, now);
}

function inUnitSince(admitTick, now) {
  if (admitTick < 0) return dayOf(now) === 0 ? `before ${clock(0)}` : `before ${dayClock(0)}`;
  return when(admitTick, now);
}

function waitedFor(hours) {
  return hours > 0 ? `waiting ${hours}h` : "just joined";
}

// -- chart helpers -------------------------------------------------------------------
/** Axis maximum and gridline step: a round number at or above the largest value. */
function niceScale(maxValue, maxLines = 5) {
  const top = Math.max(1, maxValue);
  for (const step of [1, 2, 5, 10, 20, 25, 50, 100, 200, 500]) {
    if (Math.ceil(top / step) <= maxLines) return { max: Math.ceil(top / step) * step, step };
  }
  const step = 10 ** Math.ceil(Math.log10(top / maxLines));
  return { max: Math.ceil(top / step) * step, step };
}

const f1 = (n) => n.toFixed(1);

/** Width to draw charts at: the previous render's chart width, else a guess from the page. */
function chartWidth(container) {
  let w = container.querySelector?.(".unit-chart-box")?.clientWidth;
  const page = container.clientWidth;
  // page padding, rail and gap on wide screens, then the card's own padding
  if (!w && page) w = page > 1180 ? page - 40 - 360 - 20 - 34 : page - 32 - 34;
  return Math.round(Math.max(280, Math.min(760, w || 720)));
}

/** Shared x layout for both charts: one slot per hour from the first history hour to the last projected one. */
function timeAxis(rows, projection, width) {
  const m = { top: 30, right: 44, bottom: 30, left: 40 };
  const t0 = rows[0].tick;
  const tNow = rows.at(-1).tick;
  const tEnd = projection.length ? projection.at(-1).tick : tNow;
  const plotW = width - m.left - m.right;
  const span = Math.max(1, tEnd - t0);
  const perHour = plotW / span;
  const x = (t) => m.left + ((t - t0) / span) * plotW;
  // Label every n hours (aligned to the clock) so labels stay at least ~52px apart.
  const every = [1, 2, 3, 4, 6, 12].find((n) => n * perHour >= 52) ?? 24;
  const labelled = [];
  for (let t = t0; t <= tEnd; t++) if ((DAY_START.hour + t) % every === 0) labelled.push(t);
  return { m, t0, tNow, tEnd, x, perHour, labelled, width };
}

function xLabels(axis, baseY) {
  return axis.labelled.map(
    (t) => html`<line class="unit-tick" x1="${f1(axis.x(t))}" x2="${f1(axis.x(t))}" y1="${baseY}" y2="${baseY + 4}" stroke="var(--line)" />
      <text class="unit-axis" x="${f1(axis.x(t))}" y="${baseY + 17}" text-anchor="middle">${clock(t)}</text>`,
  );
}

function yGrid(axis, scale, y, plotRight) {
  const lines = [];
  for (let v = 0; v <= scale.max; v += scale.step) {
    lines.push(html`<line class="unit-grid" x1="${axis.m.left}" x2="${plotRight}" y1="${f1(y(v))}" y2="${f1(y(v))}" stroke="var(--line)" />
      <text class="unit-axis" x="${axis.m.left - 8}" y="${f1(y(v) + 4)}" text-anchor="end">${v}</text>`);
  }
  return lines;
}

/** Hover layer: one invisible column per hour that reveals a guide line and a small label box. */
function hoverColumns(axis, top, bottom, linesFor) {
  const half = Math.max(4, axis.perHour / 2);
  const cols = [];
  for (let t = axis.t0; t <= axis.tEnd; t++) {
    const cx = axis.x(t);
    const left = Math.max(axis.m.left - 4, cx - half);
    const right = Math.min(axis.width - axis.m.right + 4, cx + half);
    const lines = linesFor(t);
    const boxW = Math.ceil(Math.max(...lines.map((l) => l.length)) * TIP_CHAR_W + 16);
    const boxH = lines.length * 15 + 10;
    const boxX = cx + 8 + boxW > axis.width - 2 ? cx - 8 - boxW : cx + 8;
    cols.push(html`<g class="unit-hit">
      <rect class="unit-hit-area" x="${f1(left)}" y="${top}" width="${f1(right - left)}" height="${bottom - top}" fill="transparent" />
      <g class="unit-tip" aria-hidden="true">
        <line x1="${f1(cx)}" x2="${f1(cx)}" y1="${top}" y2="${bottom}" stroke="var(--ink-3)" stroke-width="1" />
        <rect x="${f1(boxX)}" y="${top + 2}" width="${boxW}" height="${boxH}" rx="5" fill="var(--surface)" stroke="var(--line)" />
        ${lines.map(
          (l, i) =>
            html`<text class="${i === 0 ? "unit-tip-time" : "unit-tip-text"}" x="${f1(boxX + 8)}" y="${top + 19 + i * 15}">${l}</text>`,
        )}
      </g>
    </g>`);
  }
  return cols;
}

// -- charts ------------------------------------------------------------------------------
function chartData(twin, unit, unitSnap) {
  const { history, projection } = twin.unitHistory(unit);
  const rows = history.slice(-HISTORY_WINDOW).map((r) => ({ ...r }));
  // The last history row was taken at the start of this hour; an approved plan may have
  // moved patients since, so "now" shows the live count the rest of the page uses.
  if (rows.length) rows.at(-1).inUse = unitSnap.bedsOccupied;
  return { rows, projection };
}

function bedsChart(data, unitSnap, width, unit) {
  const { rows, projection } = data;
  const axis = timeAxis(rows, projection, width);
  const { m, x, tNow, tEnd } = axis;
  const H = 260;
  const plotBottom = H - m.bottom;
  const plotRight = width - m.right;
  const staffedNow = unitSnap.bedsStaffed;
  const values = [...rows.map((r) => r.inUse), ...rows.map((r) => r.usable), ...projection.map((p) => p.projectedInUse), staffedNow];
  const scale = niceScale(Math.max(...values));
  const y = (v) => m.top + (plotBottom - m.top) * (1 - v / scale.max);

  const nowX = x(tNow);
  const nowV = rows.at(-1).inUse;
  const nowY = y(nowV);
  const inUseLine = rows.map((r, i) => `${i ? "L" : "M"}${f1(x(r.tick))},${f1(y(r.inUse))}`).join(" ");
  const area = `${inUseLine} L${f1(nowX)},${f1(y(0))} L${f1(x(rows[0].tick))},${f1(y(0))} Z`;

  // Usable today changes in steps (an overflow bay opening), and holds for the rest of the day.
  let usablePath = `M${f1(x(rows[0].tick))},${f1(y(rows[0].usable))}`;
  for (let i = 1; i < rows.length; i++) usablePath += ` H${f1(x(rows[i].tick))} V${f1(y(rows[i].usable))}`;
  usablePath += ` V${f1(y(staffedNow))} H${f1(x(tEnd))}`;

  const projPath = [`M${f1(nowX)},${f1(nowY)}`, ...projection.map((p) => `L${f1(x(p.tick))},${f1(y(p.projectedInUse))}`)].join(" ");
  const projEnd = projection.at(-1);

  // Direct labels: the live value at the dot, usable today and the projection at the right edge.
  const dotLabelY = nowY - 12 < m.top + 4 ? nowY + 20 : nowY - 12;
  const usableY = y(staffedNow);
  const projY = projEnd ? y(projEnd.projectedInUse) : null;
  const projLabel = projEnd && Math.abs(projY - usableY) >= 14;
  // With little history "now" sits near the left edge: put its label to the right instead.
  const roomLeft = nowX - m.left >= 70;
  // "next 6 h, projected" when it fits to the right of "now", else the short "+6 h".
  const roomRight = width - 2 - (nowX + 6);
  const regionText = [`next ${projection.length} h, projected`, `+${projection.length} h`].find(
    (t) => t.length * TIP_CHAR_W <= roomRight,
  );
  const showRegionLabel = projection.length && roomLeft && regionText;

  const byTick = new Map(rows.map((r) => [r.tick, r]));
  const projByTick = new Map(projection.map((p) => [p.tick, p]));
  const tip = (t) => {
    const r = byTick.get(t);
    if (r) return [t === tNow ? `${clock(t)} (now)` : clock(t), `${r.inUse} in use`, `${r.usable} usable today`];
    const p = projByTick.get(t);
    return [`${clock(t)} (projected)`, `~${p.projectedInUse} in use`, `${staffedNow} usable today`];
  };

  const label = `${unit} beds in use from ${when(rows[0].tick, tNow)} to now: ${nowV} of ${staffedNow} usable today. ${
    projEnd ? `Projected ${projEnd.projectedInUse} at ${clock(projEnd.tick)}.` : ""
  }`;

  return html`<svg class="unit-chart" viewBox="0 0 ${width} ${H}" width="100%" role="img" aria-label="${label}">
    ${
      projection.length
        ? html`<rect class="unit-ahead" x="${f1(nowX)}" y="${m.top}" width="${f1(x(tEnd) - nowX)}" height="${plotBottom - m.top}" fill="var(--surface-2)" />`
        : ""
    }
    ${yGrid(axis, scale, y, plotRight)}
    <line class="unit-baseline" x1="${m.left}" x2="${plotRight}" y1="${plotBottom}" y2="${plotBottom}" stroke="var(--ink-3)" />
    ${xLabels(axis, plotBottom)}
    <path d="${area}" fill="var(--seq-4)" fill-opacity="0.1" stroke="none" />
    <path d="${usablePath}" fill="none" stroke="var(--ink-2)" stroke-width="1.5" stroke-linejoin="round" />
    <path d="${projPath}" fill="none" stroke="var(--seq-4)" stroke-width="2" stroke-dasharray="5 4" stroke-linecap="round" stroke-linejoin="round" />
    <path d="${inUseLine}" fill="none" stroke="var(--seq-4)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    <line x1="${f1(nowX)}" x2="${f1(nowX)}" y1="${m.top - 6}" y2="${plotBottom}" stroke="var(--ink-2)" stroke-width="1" />
    <text class="unit-now" x="${f1(roomLeft ? nowX - 5 : nowX + 5)}" y="${m.top - 12}" text-anchor="${roomLeft ? "end" : "start"}">now ${clock(tNow)}</text>
    ${showRegionLabel ? html`<text class="unit-axis" x="${f1(nowX + 6)}" y="${m.top - 12}">${regionText}</text>` : ""}
    <text class="unit-value" x="${f1(plotRight + 6)}" y="${f1(usableY + 4)}">${staffedNow}</text>
    ${projLabel ? html`<text class="unit-value unit-value-soft" x="${f1(plotRight + 6)}" y="${f1(projY + 4)}">~${projEnd.projectedInUse}</text>` : ""}
    <circle cx="${f1(nowX)}" cy="${f1(nowY)}" r="4.5" fill="var(--seq-4)" stroke="var(--surface)" stroke-width="2" />
    <text class="unit-value" x="${f1(roomLeft ? nowX - 8 : nowX + 8)}" y="${f1(dotLabelY)}" text-anchor="${roomLeft ? "end" : "start"}">${nowV}</text>
    ${hoverColumns(axis, m.top, plotBottom, tip)}
  </svg>`;
}

/** A column with a 4px rounded data-end and a square foot on the baseline. */
function barPath(x0, w, yTop, yBase) {
  const r = Math.min(4, w / 2, yBase - yTop);
  return `M${f1(x0)},${f1(yBase)} V${f1(yTop + r)} Q${f1(x0)},${f1(yTop)} ${f1(x0 + r)},${f1(yTop)} H${f1(x0 + w - r)} Q${f1(
    x0 + w,
  )},${f1(yTop)} ${f1(x0 + w)},${f1(yTop + r)} V${f1(yBase)} Z`;
}

// Moves between units (and out to other hospitals) per history row; 0 on rows without them.
const movedIn = (r) => r.transfersIn ?? 0;
const movedOut = (r) => r.transfersOut ?? 0;
const hasMoves = (rows) => rows.some((r) => r.transfersIn !== undefined || r.transfersOut !== undefined);

function flowChart(data, width, unit) {
  const { rows, projection } = data;
  const axis = timeAxis(rows, projection, width);
  const { m, x, tNow, tEnd } = axis;
  const H = 160;
  const top = 14;
  const plotBottom = H - m.bottom;
  const plotRight = width - m.right;
  const scale = niceScale(Math.max(...rows.map((r) => Math.max(r.arrivals + movedIn(r), r.discharges + movedOut(r)))), 3);
  const y = (v) => top + (plotBottom - top) * (1 - v / scale.max);
  const barW = Math.max(2, Math.min(24, (axis.perHour * 0.72 - 2) / 2));

  // Two stacked columns per hour: in (arrived, then moved in on top) and out (went home,
  // then moved out on top). The rounded end sits on whichever segment is on top.
  const column = (x0, base, extra, fill) => {
    if (!base && !extra) return "";
    const yBase = y(base);
    const yTop = y(base + extra);
    const lower = !base ? "" : extra
      ? html`<rect x="${f1(x0)}" y="${f1(yBase)}" width="${f1(barW)}" height="${f1(plotBottom - yBase)}" fill="${fill}" />`
      : html`<path d="${barPath(x0, barW, yBase, plotBottom)}" fill="${fill}" />`;
    const upper = extra
      ? html`<path d="${barPath(x0, barW, yTop, base ? yBase - 1 : plotBottom)}" fill="${fill}" fill-opacity="0.4" />`
      : "";
    return html`${lower}${upper}`;
  };
  const bars = rows.map((r) => {
    const cx = x(r.tick);
    return html`${column(cx - barW - 1, r.arrivals, movedIn(r), "var(--seq-4)")}
      ${column(cx + 1, r.discharges, movedOut(r), "var(--ink-3)")}`;
  });

  const byTick = new Map(rows.map((r) => [r.tick, r]));
  const tip = (t) => {
    const r = byTick.get(t);
    if (!r) return [`${clock(t)} (ahead)`, "not happened yet"];
    const lines = [clock(t), `${r.arrivals} arrived`];
    if (hasMoves(rows)) lines.push(`${movedIn(r)} moved in`);
    lines.push(`${r.discharges} went home`);
    if (hasMoves(rows)) lines.push(`${movedOut(r)} moved out`);
    return lines;
  };
  const sum = (f) => rows.reduce((n, r) => n + f(r), 0);
  const moves = hasMoves(rows) ? `, ${sum(movedIn)} moved in, ${sum(movedOut)} moved out` : "";
  const label = `${unit} since ${when(rows[0].tick, tNow)}: ${sum((r) => r.arrivals)} arrivals, ${sum((r) => r.discharges)} went home${moves}.`;

  return html`<svg class="unit-chart" viewBox="0 0 ${width} ${H}" width="100%" role="img" aria-label="${label}">
    ${
      projection.length
        ? html`<rect class="unit-ahead" x="${f1(x(tNow))}" y="${top}" width="${f1(x(tEnd) - x(tNow))}" height="${plotBottom - top}" fill="var(--surface-2)" />`
        : ""
    }
    ${yGrid(axis, scale, y, plotRight)}
    ${bars}
    <line class="unit-baseline" x1="${m.left}" x2="${plotRight}" y1="${plotBottom}" y2="${plotBottom}" stroke="var(--ink-3)" />
    ${xLabels(axis, plotBottom)}
    ${hoverColumns(axis, top, plotBottom, tip)}
  </svg>`;
}

function lineKey(stroke, { dashed = false, width = 2 } = {}) {
  return raw(
    `<svg class="unit-key" viewBox="0 0 22 10" width="22" height="10" aria-hidden="true"><line x1="1" x2="21" y1="5" y2="5" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round"${
      dashed ? ' stroke-dasharray="5 4"' : ""
    }/></svg>`,
  );
}

function hourlyTable(data, show) {
  const { rows, projection } = data;
  const now = rows.at(-1).tick;
  const moves = hasMoves(rows);
  const button = html`<button class="btn btn-ghost unit-toggle" data-action="toggle-hours" data-focus-key="unit-toggle-hours" aria-expanded="${show}" aria-controls="unit-hours">
    ${show ? "Hide the hourly numbers" : "Show the hourly numbers"}
  </button>`;
  if (!show) return button;
  return html`${button}
    <div class="table-wrap unit-scroll" id="unit-hours" data-keep-scroll="unit-hours" role="region" aria-label="Hourly numbers" tabindex="0">
      <table class="table">
        <thead><tr><th>Hour</th><th>In use</th><th>Usable today</th><th>Arrived</th>${moves ? html`<th>Moved in</th>` : ""}<th>Went home</th>${
          moves ? html`<th>Moved out</th>` : ""
        }<th>Waiting to move in</th></tr></thead>
        <tbody>
          ${[...rows].reverse().map(
            (r, i) => html`<tr>
              <td class="num">${hourLabel(r.tick, now)}${i === 0 ? html` <span class="faint">now</span>` : ""}</td>
              <td class="num">${r.inUse}</td><td class="num">${r.usable}</td>
              <td class="num">${r.arrivals}</td>${moves ? html`<td class="num">${movedIn(r)}</td>` : ""}
              <td class="num">${r.discharges}</td>${moves ? html`<td class="num">${movedOut(r)}</td>` : ""}
              <td class="num">${r.queueLength}</td>
            </tr>`,
          )}
          ${projection.map(
            (p) => html`<tr class="unit-row-ahead">
              <td class="num">${hourLabel(p.tick, now)} <span class="faint">projected</span></td>
              <td class="num">~${p.projectedInUse}</td>${Array.from({ length: moves ? 6 : 4 }, () => html`<td class="faint">—</td>`)}
            </tr>`,
          )}
        </tbody>
      </table>
    </div>`;
}


// -- main column ------------------------------------------------------------------------------
function chartsCard(data, unitSnap, unit, width, showHours, snap) {
  const firstTick = data.rows[0].tick;
  const nowTick = data.rows.at(-1).tick;
  const title = dayOf(firstTick) === dayOf(nowTick) ? "Beds in use today" : `Beds in use, last ${data.rows.length} hours`;
  // "19:00" today, "yesterday 19:00", or the weekday further back.
  const since = dayOf(firstTick) === dayOf(nowTick) || dayOf(nowTick) - dayOf(firstTick) === 1
    ? when(firstTick, nowTick)
    : (data.rows[0].dayTime ?? dayClock(firstTick));
  const moves = hasMoves(data.rows);
  return html`<section class="pane" aria-labelledby="unit-chart-title">
    <header class="pane-head">
      <div>
        <h2 id="unit-chart-title">${title}</h2>
        <p>From ${since} to now, then the next ${data.projection.length} hours projected from the discharges already planned and the recent rate of arrivals and moves between units.</p>
      </div>
      ${prov("simulated", { label: "Simulated, forecast", title: `Seeded simulation (seed ${snap.seed}); the dashed part is a projection` })}
    </header>
    <div class="pane-body">
      <div class="legend" aria-hidden="true">
        <span>${lineKey("var(--seq-4)")} In use</span>
        <span>${lineKey("var(--ink-2)", { width: 1.5 })} Usable today</span>
        <span>${lineKey("var(--seq-4)", { dashed: true })} Projected</span>
      </div>
      <div class="unit-chart-box">${bedsChart(data, unitSnap, width, unit)}</div>

      <div class="unit-card-sub">
        <h3>${moves ? "Patients in and out" : "Arrivals and discharges"}</h3>
        <p class="unit-card-note">${
          moves
            ? "Per hour: new patients and patients moved in from other units, then patients who went home and patients moved out to other units or hospitals."
            : "New patients and patients who went home, per hour. Moves between units and to other hospitals are not counted."
        }</p>
        <div class="legend" aria-hidden="true">
          <span><i class="swatch" style="background: var(--seq-4)"></i> Arrived</span>
          ${moves ? html`<span><i class="swatch unit-swatch-soft" style="background: var(--seq-4)"></i> Moved in</span>` : ""}
          <span><i class="swatch" style="background: var(--ink-3)"></i> Went home</span>
          ${moves ? html`<span><i class="swatch unit-swatch-soft" style="background: var(--ink-3)"></i> Moved out</span>` : ""}
        </div>
      </div>
      <div class="unit-chart-box">${flowChart(data, width, unit)}</div>
      <div class="unit-hours">${hourlyTable(data, showHours)}</div>
    </div>
  </section>`;
}

function patientsCard(patients, snap, unit) {
  const sorted = [...patients].sort(
    (a, b) => (a.bed ?? Infinity) - (b.bed ?? Infinity) || Number(a.id.slice(1)) - Number(b.id.slice(1)),
  );
  const hallway = sorted.filter((p) => p.bed === null).length;
  return html`<section class="pane" aria-labelledby="unit-patients-title">
    <header class="pane-head">
      <div>
        <h2 id="unit-patients-title">Patients</h2>
        <p>${
          sorted.length
            ? `${plural(sorted.length, "patient")} in ${unit}${hallway ? `, ${hallway} of them in the hallway without a usable bed` : ""}. Simulated patients; nothing here leaves the unit.`
            : "Simulated patients; nothing here leaves the unit."
        }</p>
      </div>
      ${simBadge(snap)}
    </header>
    ${
      sorted.length
        ? html`<div class="table-wrap unit-scroll" data-keep-scroll="unit-patients" role="region" aria-label="Patients in ${unit}" tabindex="0">
            <table class="table unit-patients">
              <thead><tr><th>Bed</th><th>Patient</th><th class="unit-wide">Condition</th><th>Acuity</th><th class="unit-wide">In unit since</th><th class="unit-wide">Leaves ~</th><th class="unit-wide">Emergency</th><th class="unit-narrow">Stay</th></tr></thead>
              <tbody>
                ${sorted.map(
                  (p) => html`<tr class="${p.bed === null ? "unit-row-hallway" : ""}">
                    <td>${p.bed === null ? pill("Hallway", "warn") : html`<span class="num">${p.bed}</span>`}</td>
                    <td>
                      <span class="num">${p.id}</span>
                      <span class="unit-narrow unit-cell-sub unit-cell-cond">${p.condition}</span>
                      ${p.surge ? html`<span class="unit-narrow unit-cell-sub">${pill("Bus accident", "crit")}</span>` : ""}
                    </td>
                    <td class="unit-wide">${p.condition}</td>
                    <td>${acuity(p.acuity)}</td>
                    <td class="num unit-wide">${inUnitSince(p.admitTick, snap.tick)}</td>
                    <td class="num unit-wide">${when(p.expectedDischargeTick, snap.tick)}</td>
                    <td class="unit-wide">${p.surge ? pill("Bus accident", "crit") : html`<span class="faint">—</span>`}</td>
                    <td class="num unit-narrow unit-stay">
                      <span class="unit-cell-sub"><span class="faint">since</span> <span class="unit-nowrap">${inUnitSince(p.admitTick, snap.tick)}</span></span>
                      <span class="unit-cell-sub"><span class="faint">leaves ~</span> <span class="unit-nowrap">${when(p.expectedDischargeTick, snap.tick)}</span></span>
                    </td>
                  </tr>`,
                )}
              </tbody>
            </table>
          </div>`
        : html`<div class="pane-body"><p class="muted">No patients in this unit right now.</p></div>`
    }
  </section>`;
}

// -- rail ---------------------------------------------------------------------------------------
/** Counts only, up to the hospital: what this unit shares with the bed managers every hour. */
function sharedByUnitCard(unitSnap, patients, snap, unit) {
  const { bedsOccupied: inUse, bedsStaffed: usable, bedsTotal } = unitSnap;
  const free = usable - inUse;
  const upcoming = patients.filter((p) => p.expectedDischargeTick > snap.tick);
  const next = upcoming.reduce((min, p) => Math.min(min, p.expectedDischargeTick), Infinity);
  const soon = patients.filter((p) => p.expectedDischargeTick > snap.tick && p.expectedDischargeTick <= snap.tick + 3).length;
  return html`<section class="pane" aria-labelledby="unit-shared-by-title">
    <header class="pane-head">
      <div>
        <h2 id="unit-shared-by-title">Shared by me</h2>
        <p>To the hospital's bed managers, every hour: counts only</p>
      </div>
      ${simBadge(snap)}
    </header>
    <div class="pane-body">
      <dl class="kv">
        <dt>Free beds</dt>
        <dd class="num">${free >= 0 ? free : html`none, <strong class="is-crit-text">${-free} over</strong>`}</dd>
        <dt>Closed today (no staff)</dt>
        <dd class="num">${Math.max(0, bedsTotal - usable)}</dd>
        <dt>Expected to leave, next 3 h</dt>
        <dd class="num">${soon}</dd>
        <dt>Next discharge</dt>
        <dd class="num">${Number.isFinite(next) ? when(next, snap.tick) : "none planned"}</dd>
        <dt>${unit === "ED" ? "Waiting for a bed upstairs" : "Waiting to move in"}</dt>
        <dd class="num">${waitingList(snap, unit).length}</dd>
      </dl>
      <div class="never"><b>Never leaves the unit:</b> patient data to staff without a treatment relationship; staff health or performance data.</div>
    </div>
  </section>`;
}

/** The rest of the hospital, as status per unit. */
function sharedWithUnitCard(snap, unit, routes) {
  const others = UNITS.filter((u) => u !== unit);
  return html`<section class="pane" aria-labelledby="unit-shared-with-title">
    <header class="pane-head">
      <div>
        <h2 id="unit-shared-with-title">Shared with me</h2>
        <p>The other units of ${OWN_HOSPITAL.name}</p>
      </div>
      ${simBadge(snap)}
    </header>
    <div class="pane-body">
      <dl class="kv">
        ${others.map((u) => {
          const s = capabilityStatus(snap.units[u]);
          return html`<dt><a href="#${routes.unit(u)}" data-focus-key="unit-peer-${u}">${UNIT_LABEL[u]}</a></dt><dd><span class="cap is-${s.tone}">${s.word}${s.reason ? html`<small>${s.reason}</small>` : ""}</span></dd>`;
        })}
      </dl>
      <p class="pane-note">A patient's record moves only with the patient, to the receiving unit.</p>
    </div>
  </section>`;
}

/** ICU and Ward: who waits to move in. ED: who waits in the ED for a bed upstairs. */
function waitingList(snap, unit) {
  if (unit === "ED") {
    return UNITS.filter((u) => u !== "ED").flatMap((u) =>
      snap.units[u].queue.filter((q) => q.from === "ED").map((q) => ({ ...q, where: `to ${u}` })),
    );
  }
  return snap.units[unit].queue.map((q) => ({ ...q, where: `from ${q.from}` }));
}

function railPane(id, title, sub, snap, body) {
  return html`<section class="pane" aria-labelledby="${id}">
    <header class="pane-head">
      <div><h2 id="${id}">${title}</h2>${sub ? html`<p>${sub}</p>` : ""}</div>
      ${simBadge(snap)}
    </header>
    <div class="pane-body">${body}</div>
  </section>`;
}

function waitingCard(snap, unit) {
  const list = waitingList(snap, unit).sort((a, b) => b.acuity - a.acuity || b.waitingTicks - a.waitingTicks);
  const title = unit === "ED" ? "Waiting for a bed upstairs" : "Waiting to move in";
  const empty = unit === "ED" ? "Nobody in the ED is waiting for an ICU or ward bed." : `Nobody is waiting to move into ${unit}.`;
  return railPane(
    "unit-waiting-title",
    title,
    "Sickest first",
    snap,
    list.length
      ? html`<ul class="unit-list">
          ${list.map(
            (q) => html`<li>
              ${acuity(q.acuity)}
              <span class="unit-list-main"><span class="num">${q.patientId}</span> <span class="muted">${q.condition}</span></span>
              <span class="unit-list-meta">${q.where}, ${waitedFor(q.waitingTicks)}</span>
            </li>`,
          )}
        </ul>`
      : html`<p class="muted">${empty}</p>`,
  );
}

function conditionsCard(patients, snap) {
  const counts = new Map();
  for (const p of patients) {
    const row = counts.get(p.condition) ?? { total: 0, byAcuity: [0, 0, 0, 0, 0, 0] };
    row.total += 1;
    row.byAcuity[Math.max(1, Math.min(5, p.acuity))] += 1;
    counts.set(p.condition, row);
  }
  const known = CONDITION_ORDER.filter((c) => counts.has(c));
  const extra = [...counts.keys()].filter((c) => !CONDITION_ORDER.includes(c));
  const conditions = [...known, ...extra];
  const maxTotal = Math.max(1, ...[...counts.values()].map((r) => r.total));
  const TRACK_PX = 200; // rough bar track width in the rail, to decide if a count fits inside

  return railPane(
    "unit-cond-title",
    "Conditions right now",
    "Patients by condition, coloured by acuity",
    snap,
    conditions.length
      ? html`<div class="unit-cond">
          ${conditions.map((c) => {
            const row = counts.get(c);
            const parts = [5, 4, 3, 2, 1].filter((a) => row.byAcuity[a]);
            const said = parts.map((a) => `${row.byAcuity[a]} at acuity ${a}`).join(", ");
            return html`<div class="unit-cond-row">
              <span class="unit-cond-name">${c}</span>
              <span class="unit-cond-track" role="img" aria-label="${c}: ${row.total} patients, ${said}">
                <span class="unit-cond-bar" style="width: ${f1((row.total / maxTotal) * 100)}%">
                  ${parts.map((a) => {
                    const n = row.byAcuity[a];
                    const fits = (n / maxTotal) * TRACK_PX >= 18;
                    return html`<span class="unit-seg tri tri-${a}" style="flex-grow: ${n}" title="${c}, acuity ${a} (${ACUITY_LABEL[a]}): ${n}">${fits ? n : ""}</span>`;
                  })}
                </span>
              </span>
              <span class="unit-cond-total num">${row.total}</span>
            </div>`;
          })}
        </div>
        <div class="legend unit-cond-legend">
          ${[5, 4, 3, 2, 1].map((a) => html`<span><i class="swatch" style="background: var(--tri-${a})"></i>${a} ${ACUITY_LABEL[a]}</span>`)}
        </div>`
      : html`<p class="muted">No patients in this unit right now.</p>`,
  );
}

function plansCard(plans, snap) {
  return railPane(
    "unit-plans-title",
    "Recent plans for this unit",
    "",
    snap,
    plans.length
      ? html`<ul class="unit-list">
          ${plans.map(
            (p) => html`<li class="unit-plan">
              <span class="num">${p.hourRange}</span>
              ${pill(PLAN_LABEL[p.status] ?? p.status, PLAN_TONE[p.status] ?? "mute")}
              <span class="unit-plan-conf"><span class="faint">confidence</span> ${confBar(p.confidence)}</span>
            </li>`,
          )}
        </ul>
        ${plans.some((p) => p.status === "pending") ? html`<p class="unit-note">The waiting plan is under Requests.</p>` : ""}`
      : html`<p class="muted">No plans for this unit yet.</p>`,
  );
}

function rejectionsCard(unitSnap, snap) {
  const said = [...unitSnap.recentRejections].reverse();
  return railPane(
    "unit-said-title",
    "What the charge nurse said recently",
    "",
    snap,
    said.length
      ? html`<div class="unit-quotes">
          ${said.map((text) =>
            text === "rejected"
              ? html`<p class="muted unit-quote">Rejected a plan without giving a reason.</p>`
              : html`<blockquote class="unit-quote">“${text}”</blockquote>`,
          )}
        </div>
        <p class="faint unit-note">The unit's planner keeps these in mind for the next few hours.</p>`
      : html`<p class="muted">No recent rejections.</p>`,
  );
}

// -- head and KPIs ------------------------------------------------------------------------------
function unitTabs(snap, current, routes) {
  return html`<nav class="unit-tabs" aria-label="Units of ${OWN_HOSPITAL.name}">
    ${UNITS.map((u) => {
      const s = snap.units[u];
      const tone = utilTone(s.bedsStaffed ? s.bedsOccupied / s.bedsStaffed : 0);
      return html`<a class="unit-tab" href="#${routes.unit(u)}" data-focus-key="unit-tab-${u}"${u === current ? raw(' aria-current="page"') : ""}>
        <span class="unit-tab-dot is-${tone}" aria-hidden="true"></span>
        <span class="unit-tab-name">${u}</span>
        <span class="unit-tab-beds num">${s.bedsOccupied}/${s.bedsStaffed}</span>
      </a>`;
    })}
  </nav>`;
}

function unitKpis(data, unitSnap, snap, unit) {
  const { bedsOccupied: inUse, bedsStaffed: usable, bedsTotal } = unitSnap;
  const fraction = usable ? inUse / usable : inUse ? 2 : 0;
  const free = usable - inUse;
  const closed = Math.max(0, bedsTotal - usable);
  const waiting = waitingList(snap, unit);
  const hallway = Math.max(0, inUse - usable);
  const sickest = waiting.reduce((m, q) => Math.max(m, q.acuity), 0);
  const end = data.projection.at(-1);
  const sim = simBadge(snap);
  const net = end ? end.projectedInUse - inUse : null;
  return kpiStrip([
    {
      label: "Beds in use",
      value: Math.round(fraction * 100),
      unit: "%",
      detail: `${inUse} patients in ${usable} usable beds`,
      badge: sim,
      alert: fraction > 0.95,
      spark: data.rows.map((r) => (r.usable ? r.inUse / r.usable : 1)),
      sparkLabel: "Share of usable beds in use, recent hours",
    },
    {
      label: "Free beds now",
      value: Math.max(0, free),
      detail: free >= 0 ? `of ${usable} usable today` : `${-free} patients over the usable beds`,
      badge: sim,
      alert: free <= 0,
    },
    {
      label: "Closed: no staff",
      value: closed,
      unit: closed === 1 ? "bed" : "beds",
      detail: `of ${bedsTotal} beds; they open when a nurse is on shift`,
      badge: sim,
    },
    {
      label: unit === "ED" ? "Waiting for a bed upstairs" : "Waiting to move in",
      value: waiting.length,
      unit: waiting.length === 1 ? "patient" : "patients",
      detail: hallway
        ? `${hallway} in the hallway without a usable bed`
        : waiting.length
          ? `sickest at acuity ${sickest} (${ACUITY_LABEL[sickest]})`
          : "nobody waiting",
      badge: sim,
      alert: hallway > 0 || sickest >= 4,
    },
    end
      ? {
          label: `Next ${data.projection.length} h, net`,
          value: net > 0 ? `+${net}` : net < 0 ? `−${-net}` : "±0",
          unit: "patients",
          detail: `projected ${end.projectedInUse} in use at ${clock(end.tick)}`,
          badge: prov("simulated", { label: "Forecast", title: "Projection of the seeded simulation, not a measurement" }),
        }
      : null,
  ]);
}

// -- view ------------------------------------------------------------------------------------
let lastRerender = null;
let resizeTimer = null;
if (typeof window !== "undefined") {
  // Charts are drawn at their real width so text stays readable; redraw after a resize.
  // Only a width change matters: phones fire resize when the address bar shows or hides.
  let lastWidth = window.innerWidth;
  window.addEventListener("resize", () => {
    if (window.innerWidth === lastWidth) return;
    lastWidth = window.innerWidth;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (lastRerender && document.querySelector(".unit-chart-box")) lastRerender();
    }, 200);
  });
}

export function render(container, ctx) {
  const { twin, snap, route, routes } = ctx;
  const unit = route.unit;
  const unitSnap = snap.units[unit];
  lastRerender = ctx.rerender;
  if (!unitSnap) {
    container.innerHTML = String(html`<p class="muted">This unit is not part of the twin.</p>`);
    return;
  }
  const state = (ctx.ui.unitView ??= { showHours: false });
  const patients = snap.patients.filter((p) => p.unit === unit);
  const data = chartData(twin, unit, unitSnap);
  const width = chartWidth(container);
  const fraction = unitSnap.bedsStaffed ? unitSnap.bedsOccupied / unitSnap.bedsStaffed : unitSnap.bedsOccupied ? 2 : 0;

  container.innerHTML = String(html`
    <div class="pg">
      ${pageHead({
        level: "Unit",
        place: `${OWN_HOSPITAL.name} · demo twin`,
        title: `${UNIT_LABEL[unit]} (${unit})`,
        question: UNIT_ROLE[unit],
        sees: "every bed and patient in this unit; shares only counts with the hospital.",
        status: utilStatus(fraction),
        fresh: { badge: simBadge(snap), text: `Twin time ${snap.dayTime}` },
        extra: unitTabs(snap, unit, routes),
      })}
      ${data.rows.length ? unitKpis(data, unitSnap, snap, unit) : ""}
      <div class="pg-grid">
        <div class="pg-main">
          ${bedBoard(ctx, [unit], { links: false, title: "Beds" })}
          ${data.rows.length ? chartsCard(data, unitSnap, unit, width, state.showHours, snap) : ""}
          ${patientsCard(patients, snap, unit)}
        </div>
        <aside class="pg-rail" aria-label="${unit}: requests and sharing">
          ${requestsCard(ctx, { focusUnit: unit })}
          ${sharedByUnitCard(unitSnap, patients, snap, unit)}
          ${sharedWithUnitCard(snap, unit, routes)}
          ${waitingCard(snap, unit)}
          ${conditionsCard(patients, snap)}
          ${plansCard(twin.unitPlans(unit), snap)}
          ${rejectionsCard(unitSnap, snap)}
        </aside>
      </div>
      ${levelsPanel("unit", { place: `${UNIT_LABEL[unit]}, ${OWN_HOSPITAL.name}`, links: { hospital: OWN_HOSPITAL.id } })}
      ${sourcesFooter([
        { badge: simBadge(snap), text: `Every patient, bed and number on this page comes from the seeded simulation (seed ${snap.seed}); ${OWN_HOSPITAL.name} is a fictional demo twin. No real patient data is used.` },
        { badge: html`<span class="prov is-rule">Rule</span>`, text: "Acuity uses the five Manchester Triage colours. The unit planner, the Coordinator and the Safety check are rule-based; a person approves every plan." },
        { badge: prov("illustrative"), text: "What the unit shares with the hospital shows how a real deployment would work." },
      ])}
    </div>
  `);

  container.onclick = (event) => {
    if (handleDecisionClick(event, ctx)) return;
    if (handleBedClick(event, ctx)) return;
    const btn = event.target.closest("[data-action='toggle-hours']");
    if (!btn) return;
    state.showHours = !state.showHours;
    ctx.rerender();
    // The button was rebuilt by the re-render; keep keyboard focus on it.
    container.querySelector?.("[data-action='toggle-hours']")?.focus();
  };
  container.onchange = (event) => onDraftEdit(event, ctx);
  container.oninput = (event) => onDraftEdit(event, ctx);
  container.onsubmit = (event) => onRejectSubmit(event, ctx);
}
