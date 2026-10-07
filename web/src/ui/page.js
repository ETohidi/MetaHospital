// The page anatomy every level shares (concept 6.2): provenance badge, status pill, page head,
// five-slot KPI strip and sources footer. The levels panel lives in levels.js. CSS: styles/page.css.
// Page skeleton:
//   <div class="pg"> pageHead, kpiStrip, [context], <div class="pg-grid"><div class="pg-main">…</div>
//   <aside class="pg-rail">…</aside></div>, levelsPanel, sourcesFooter </div>

import { html, raw } from "./dom.js";

export const PROV_LABEL = {
  live: "Live",
  official: "Official",
  estimated: "Estimated",
  simulated: "Simulated",
  illustrative: "Illustrative",
  notshown: "Not shown",
  unknown: "Unknown",
  stale: "Stale",
};

export const PROV_HELP = {
  live: "Real, near-live data from an authority",
  official: "Annual published statistic or register",
  estimated: "Formula applied to real inputs, shown only at district level or above",
  simulated: "Output of the seeded twin for a fictional demo hospital",
  illustrative: "Shows what a flow or feed would look like; no real data behind it",
  notshown: "The data exists, but may not be shown yet",
  unknown: "No data. Never shown as 0",
  stale: "Real data, older than 2 days",
};

const attr = (s) => String(html`${s}`);

/** Provenance badge: every number says where it comes from. kind: a PROV_LABEL key (or "rule"). */
export function prov(kind, { label = PROV_LABEL[kind] ?? kind, title = PROV_HELP[kind] ?? "" } = {}) {
  return html`<span class="prov is-${kind}" ${title ? raw(` title="${attr(title)}"`) : ""}>${label}</span>`;
}

/** Status pill: colour plus a shape and a word, never colour alone. tone: ok | warn | crit | mute. */
export function pill(text, tone = "mute", { title = "" } = {}) {
  return html`<span class="pill is-${tone}" ${title ? raw(` title="${attr(title)}"`) : ""}>${text}</span>`;
}

/** The simulated-provenance badge of the demo twins, with the seed in its tooltip. */
export function simBadge(snap, label = "Simulated") {
  return prov("simulated", {
    label,
    title: `Seeded simulation of a fictional hospital (seed ${snap.seed}); the same seed replays the same day.`,
  });
}

/**
 * Page head: level pill and place, an H1, the question this screen answers, one line on what this
 * level may see, then the overall status pill and freshness (badge + text) on the right.
 * @param {{level: string, place: string, title: string, question?: string, sees?: string,
 *   status?: {text: string, tone: string, title?: string}|null, fresh?: {badge: any, text: any}|null, extra?: any}} p
 */
export function pageHead({ level, place, title, question = "", sees = "", status = null, fresh = null, extra = "" }) {
  return html`
    <header class="pg-head">
      <div class="pg-head-main">
        <div class="pg-eyebrow"><span class="pg-lvl">${level}</span><span>${place}</span></div>
        <h1>${title}</h1>
        ${question ? html`<p class="pg-q">${question}</p>` : ""}
        ${sees ? html`<p class="pg-sees"><span class="pg-sees-l">May see</span> ${sees}</p>` : ""}
      </div>
      <div class="pg-head-side">
        ${status ? pill(status.text, status.tone, { title: status.title ?? "" }) : ""}
        ${fresh ? html`<div class="pg-fresh">${fresh.badge} <span>${fresh.text}</span></div>` : ""}
      </div>
      ${extra ? html`<div class="pg-head-extra">${extra}</div>` : ""}
    </header>
  `;
}

/**
 * Five fixed KPI slots. A tile: {label, value, unit?, detail?, badge, alert?, spark?: number[],
 * sparkLabel?, extra?} or null. Fewer tiles leave the remaining slots empty, so nothing shifts
 * between levels. `extra` is trusted markup placed under the detail (a segment bar, a ready sparkline).
 */
export function kpiStrip(tiles, { label = "Key figures", busy = false } = {}) {
  const slots = tiles.slice(0, 5);
  while (slots.length < 5) slots.push(null);
  return html`<section class="kpis" aria-label="${label}" ${busy ? raw(' aria-busy="true"') : ""}>
    ${slots.map(kpiTile)}
  </section>`;
}

function kpiTile(t) {
  if (!t) return html`<div class="kpi is-empty" aria-hidden="true"></div>`;
  return html`<div class="kpi${t.alert ? " is-alert" : ""}">
    <span class="kpi-l">${t.label}</span>
    <span class="kpi-b">${t.badge}</span>
    <div class="kpi-v">${t.value}${t.unit ? html`<small>${t.unit}</small>` : ""}</div>
    ${t.detail ? html`<div class="kpi-d">${t.detail}</div>` : ""}
    ${t.spark ? sparkline(t.spark, t.sparkLabel ?? t.label) : ""}
    ${t.extra ? html`<div class="kpi-x">${t.extra}</div>` : ""}
  </div>`;
}

function sparkline(values, label) {
  if (!values || values.length < 2) return "";
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi - lo < 0.1) {
    lo -= 0.05;
    hi += 0.05;
  }
  const pts = values
    .map((v, i) => `${((i / (values.length - 1)) * 100).toFixed(1)},${(25 - ((v - lo) / (hi - lo)) * 21).toFixed(1)}`)
    .join(" ");
  const [lx, ly] = pts.split(" ").at(-1).split(",");
  return html`<svg class="kpi-spark" viewBox="0 0 100 28" preserveAspectRatio="none" role="img" aria-label="${label}">
    <polyline
      points="${pts}"
      fill="none"
      stroke="var(--seq-4)"
      stroke-width="1.5"
      vector-effect="non-scaling-stroke"
      stroke-linejoin="round"
    />
    <circle cx="${lx}" cy="${ly}" r="2" fill="var(--seq-5)" vector-effect="non-scaling-stroke" />
  </svg>`;
}

/** Sources footer: every dataset or rule on the page with its badge. Rows: {badge, text}. */
export function sourcesFooter(rows) {
  return html`<footer class="sources" aria-label="Sources">
    <h2 class="sources-h">Data &amp; sources</h2>
    ${rows.map((r) => html`<p>${r.badge} ${r.text}</p>`)}
  </footer>`;
}
