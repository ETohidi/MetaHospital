// Boot, routing, the top bar (zoom ladder + simulation controls) and the render loop.
// Views live in ui/*.js and each exports render(container, ctx, { routeChanged }).

import { Twin } from "./engine/twin.js";
import { HOSPITAL_BY_ID, OWN_HOSPITAL, UNIT_BY_ID, UNIT_IDS } from "./data/places.js";
import { esc, html, raw } from "./ui/dom.js";
import * as maps from "./ui/maps.js";
import * as hospitalView from "./ui/hospital.js";
import * as unitView from "./ui/unit.js";

const AUTOPLAY_MS = { 1: 5000, 2: 2500, 4: 1250 };

const twin = new Twin();
/** Per-viewer UI state that survives re-renders (drafts, selections, toggles). */
const ui = { drafts: {}, autoplay: false, speed: 1 };

const $ = (sel) => document.querySelector(sel);
const view = $("#view");
const ladder = $("#ladder");
const simbar = $("#simbar");
const statusline = $("#statusline");
const toasts = $("#toasts");
const topbar = $(".topbar");
const surgeLive = $("#surge-live");
const PHONE = "(max-width: 640px)";

// -- routes -------------------------------------------------------------------
// Only plain hash tokens survive the artifact viewer (letters, digits, . _ ~ -), so
// routes are "earth", "germany", "berlin", "<hospitalId>" and "<hospitalId>.<unitId>".
export const routes = {
  earth: "earth",
  germany: "germany",
  berlin: "berlin",
  hospital: (id) => id,
  unit: (unit, hospitalId = OWN_HOSPITAL.id) => `${hospitalId}.${UNIT_IDS[unit]}`,
};

function parseRoute(hash) {
  let rawToken = hash.replace(/^#/, "");
  try {
    rawToken = decodeURIComponent(rawToken);
  } catch {
    // a malformed %-escape falls through to Earth instead of blanking the app
  }
  const token = rawToken.toLowerCase();
  if (token === "germany") return { level: 2, token };
  if (token === "berlin") return { level: 3, token };
  const [hid, uid] = token.split(".");
  const hosp = HOSPITAL_BY_ID[hid];
  if (hosp) {
    if (uid && hosp.isOwn && UNIT_BY_ID[uid]) return { level: 5, token, hospitalId: hid, unit: UNIT_BY_ID[uid] };
    return { level: 4, token: hid, hospitalId: hid };
  }
  return { level: 1, token: "earth" };
}

let route = parseRoute(location.hash);

function go(token) {
  if (location.hash.replace(/^#/, "") === token) return;
  location.hash = token;
}

window.addEventListener("hashchange", () => {
  route = parseRoute(location.hash);
  render({ routeChanged: true });
});

// -- toasts ---------------------------------------------------------------------
function toast(message) {
  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", "status");
  el.textContent = message;
  toasts.append(el);
  setTimeout(() => el.remove(), 3800);
}

// -- top bar ----------------------------------------------------------------------
const ICONS = {
  next: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M3 2.5v11l7-5.5zM11 2.5h2v11h-2z"/></svg>',
  play: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 2.5v11l9-5.5z"/></svg>',
  pause: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 2.5h3v11H4zM9 2.5h3v11H9z"/></svg>',
  alert:
    '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.5l7 12.5H1zM7.2 6v4h1.6V6zm0 5.2v1.6h1.6v-1.6z"/></svg>',
  restart:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 8a5 5 0 1 0 1.6-3.7"/><path d="M3 2.5v3h3"/></svg>',
};

function ladderSteps(snap) {
  const hosp = route.hospitalId ? HOSPITAL_BY_ID[route.hospitalId] : null;
  const summary = hosp ? snap.hospitals.find((h) => h.id === hosp.id) : null;
  const hospBeds = summary ? Object.values(summary.units).reduce((n, u) => n + u.bedsTotal, 0) : null;
  const unitBeds = route.unit ? snap.units[route.unit].bedsTotal : null;
  return [
    { level: 1, name: "Earth", scale: "12,742 km", token: routes.earth },
    { level: 2, name: "Germany", scale: "876 km N–S", token: routes.germany },
    { level: 3, name: "Berlin", scale: "891 km²", token: routes.berlin },
    hosp
      ? { level: 4, name: hosp.name, scale: `${hospBeds} beds`, token: routes.hospital(hosp.id) }
      : { level: 4, name: "Hospital", scale: "pick on the map", pending: true },
    route.unit
      ? { level: 5, name: route.unit, scale: `${unitBeds} beds`, token: routes.unit(route.unit) }
      : { level: 5, name: "Unit", scale: hosp?.isOwn ? "pick a unit" : "—", pending: true },
  ];
}

function renderLadder(snap) {
  ladder.innerHTML = String(
    html`${ladderSteps(snap).map((s) => {
      const current = s.level === route.level;
      const inner = html`<span class="step-name">${s.name}</span><span class="step-scale">${s.scale}</span>`;
      if (s.pending) return html`<li><span class="step is-pending">${inner}</span></li>`;
      return html`<li><a href="#${s.token}"${current ? raw(' aria-current="page"') : ""}>${inner}</a></li>`;
    })}`,
  );
}

// The clock is built once so its live region announces only real hour changes; the buttons
// are rebuilt only when their state changes, so a focused button survives an ordinary tick.
let simbarKey = null;
let clockTime = null;
let clockDay = null;

function renderSimbar(snap) {
  if (!clockTime) {
    simbar.innerHTML = String(html`
      <div class="clock" aria-live="polite" aria-atomic="true">
        <span class="clock-time"></span>
        <span class="clock-day"></span>
      </div>
      <div class="simbar-buttons"></div>
    `);
    clockTime = simbar.querySelector(".clock-time");
    clockDay = simbar.querySelector(".clock-day");
  }
  const day = snap.dayTime.split(" ")[0];
  if (clockTime.textContent !== snap.time) clockTime.textContent = snap.time;
  if (clockDay.textContent !== day) clockDay.textContent = day;

  const key = `${ui.autoplay}|${ui.speed}`;
  if (key === simbarKey) return;
  simbarKey = key;
  simbar.querySelector(".simbar-buttons").innerHTML = String(html`
    <button class="btn btn-primary" id="btn-next" data-sim="next" title="Advance the simulation by one hour">
      ${raw(ICONS.next)} Next hour
    </button>
    <button class="btn" id="btn-play" data-sim="play" aria-pressed="${ui.autoplay}" title="Advance automatically">
      ${raw(ui.autoplay ? ICONS.pause : ICONS.play)} ${ui.autoplay ? "Pause" : "Play"}
    </button>
    <button class="btn btn-ghost" id="btn-speed" data-sim="speed" title="Autoplay speed">${ui.speed}×</button>
    <button class="btn btn-danger" id="btn-surge" data-sim="surge" title="20 casualties arrive at the Emergency Department">
      ${raw(ICONS.alert)} Bus accident
    </button>
    <button class="btn btn-ghost" id="btn-reset" data-sim="reset" title="Restart the day">
      ${raw(ICONS.restart)} <span class="btn-label">Restart</span>
    </button>
  `);
}

let surgeWas = null;

function renderStatus(snap) {
  const pending = snap.pendingBundle;
  // Announce the emergency once, when it starts; the visible banner below is not a live region.
  if (snap.surge && !surgeWas) surgeLive.textContent = `Emergency at ${OWN_HOSPITAL.name}: ${snap.surge}.`;
  if (!snap.surge) surgeLive.textContent = "";
  surgeWas = snap.surge;
  statusline.innerHTML = String(html`
    <span class="chip chip-plain">Synthetic data</span>
    <span class="chip chip-plain">Rule-based planners</span>
    <span class="faint mono status-seed">seed ${snap.seed}</span>
    ${
      pending
        ? html`<a class="chip chip-accent" href="#${routes.hospital(OWN_HOSPITAL.id)}">Plan for ${pending.hourRange} awaits a decision</a>`
        : html`<span class="chip">No plan waiting</span>`
    }
    ${
      snap.surge
        ? html`<span class="banner-emergency">Emergency at ${OWN_HOSPITAL.name}: ${snap.surge}
            <span class="mono">${snap.surgeTicksRemaining}h left</span></span>`
        : ""
    }
  `);
}

// -- simulation controls ------------------------------------------------------------
let timer = null;

/** True while the waiting plan has a typed rejection reason: ticking would expire it and drop the text. */
function hasTypedReason() {
  const pending = twin.snapshot().pendingBundle;
  return Boolean(pending && ui.drafts[pending.id]?.custom?.trim());
}

function autoTick() {
  if (isBusy() || hasTypedReason()) return; // hold the clock while the viewer is typing or deciding
  twin.tick();
}

function setAutoplay(on) {
  ui.autoplay = on;
  clearInterval(timer);
  timer = on ? setInterval(autoTick, AUTOPLAY_MS[ui.speed]) : null;
  render();
}

simbar.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-sim]");
  if (!btn) return;
  const action = btn.dataset.sim;
  if (action === "next") {
    const bundle = twin.tick();
    if (bundle && route.level < 4) toast(`${bundle.hourRange}: a new plan is waiting at ${OWN_HOSPITAL.name}.`);
    // On one-column layouts the plan sits below the bed board; bring the new one into view.
    if (bundle && route.level === 4 && matchMedia("(max-width: 980px)").matches) {
      document.getElementById("hosp-plan-title")?.scrollIntoView({ block: "start" });
    }
  } else if (action === "play") {
    setAutoplay(!ui.autoplay);
  } else if (action === "speed") {
    ui.speed = ui.speed === 1 ? 2 : ui.speed === 2 ? 4 : 1;
    if (ui.autoplay) setAutoplay(true);
    else render();
  } else if (action === "surge") {
    twin.surge();
    toast(`Bus accident: 20 casualties are arriving at the ${OWN_HOSPITAL.name} Emergency Department.`);
  } else if (action === "reset") {
    ui.drafts = {};
    twin.reset();
    toast(`The day restarted. It is ${twin.snapshot().time} again.`);
  }
});

// Any element with data-go="<route token>" navigates (cards, pins, table rows).
document.addEventListener("click", (event) => {
  const target = event.target.closest("[data-go]");
  if (!target || target.closest("a[href]")) return;
  event.preventDefault();
  go(target.dataset.go);
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const target = event.target.closest("[data-go]");
  if (!target || target.matches("a, button, input, select, textarea")) return;
  event.preventDefault();
  go(target.dataset.go);
});

// -- render loop -------------------------------------------------------------------
const VIEWS = { 1: maps, 2: maps, 3: maps, 4: hospitalView, 5: unitView };
let deferred = false;
let pointerDown = false;

/**
 * True while the viewer is typing or choosing in a form control inside the view, or is
 * mid-click: replacing the element between pointerdown and pointerup would swallow the click.
 */
function isBusy() {
  const a = document.activeElement;
  return pointerDown || Boolean(a && view.contains(a) && a.matches("input, select, textarea"));
}

function renderIfDeferred() {
  setTimeout(() => {
    if (deferred && !isBusy()) render();
  }, 0);
}

document.addEventListener("pointerdown", () => (pointerDown = true), true);
document.addEventListener(
  "pointerup",
  () => {
    pointerDown = false;
    renderIfDeferred();
  },
  true,
);
document.addEventListener("pointercancel", () => (pointerDown = false), true);

function keepScroll(fn) {
  const saved = [...view.querySelectorAll("[data-keep-scroll]")].map((el) => [el.dataset.keepScroll, el.scrollTop]);
  fn();
  for (const [key, top] of saved) {
    const el = view.querySelector(`[data-keep-scroll="${CSS.escape(key)}"]`);
    if (el) el.scrollTop = top;
  }
}

// -- focus: re-renders replace the focused element; put the keyboard user back where they were --
function focusKey() {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const tries = [];
  if (el.id) tries.push(`#${CSS.escape(el.id)}`);
  const key = el.getAttribute("data-focus-key");
  if (key) tries.push(`[data-focus-key="${CSS.escape(key)}"]`);
  // Plan controls carry the bundle id; when a new plan replaces it, land on the same control.
  const plan = key && key.match(/^(approve|reason|custom|reject)-/);
  if (plan) tries.push(`[data-focus-key^="${plan[1]}-"]`, "#hosp-plan-title");
  // A bed's patient can leave in the next hour; fall back to that unit's heading link.
  const unitLink = key?.startsWith("bed-") && el.closest(".hosp-unit")?.querySelector("[data-focus-key^='unit-']");
  if (unitLink) tries.push(`[data-focus-key="${CSS.escape(unitLink.getAttribute("data-focus-key"))}"]`);
  return tries.length ? tries : null;
}

function restoreFocus(selectors) {
  const a = document.activeElement;
  if (!selectors || (a && a !== document.body && a.isConnected)) return; // not lost, or a view restored it
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && !el.disabled) {
      if (el.id === "hosp-plan-title" && !el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
      el.focus({ preventScroll: true });
      if (document.activeElement === el) return;
    }
  }
}

function render({ routeChanged = false } = {}) {
  const snap = twin.snapshot();
  const focused = routeChanged ? null : focusKey();
  renderLadder(snap);
  renderSimbar(snap);
  renderStatus(snap);
  updateSticky();

  if (!routeChanged && isBusy()) {
    deferred = true; // don't yank a dropdown, text field or half-finished click from the viewer
    restoreFocus(focused);
    return;
  }
  deferred = false;
  const ctx = { twin, snap, route, routes, go, ui, toast, rerender: () => render() };
  const mod = VIEWS[route.level];
  // Views re-assign the handlers they need on every render; clear the previous view's.
  view.onclick = view.onchange = view.oninput = view.onsubmit = view.onkeydown = null;
  keepScroll(() => mod.render(view, ctx, { routeChanged }));
  if (routeChanged) {
    view.classList.remove("view-enter");
    void view.offsetWidth;
    view.classList.add("view-enter");
    window.scrollTo({ top: 0 });
    const h1 = view.querySelector("h1")?.textContent.trim().replace(/\s+/g, " ");
    document.title = h1 ? `${h1} · MetaHospital` : "MetaHospital";
    view.focus({ preventScroll: true });
  } else {
    restoreFocus(focused);
  }
}

// -- sticky header: on phones only the simulation strip stays on screen ------------------------
// The whole header stays sticky with a negative top, so everything above the strip scrolls away.
function updateSticky() {
  const phone = matchMedia(PHONE).matches;
  topbar.style.setProperty("--topbar-stick", phone ? `${-simbar.offsetTop}px` : "0px");
  const visible = phone ? simbar.offsetHeight : topbar.offsetHeight;
  document.documentElement.style.setProperty("--sticky-h", `${visible}px`);
}
if (typeof ResizeObserver === "function") new ResizeObserver(updateSticky).observe(topbar);

view.addEventListener("focusout", renderIfDeferred);

twin.subscribe(() => render());
render({ routeChanged: true });

// Exposed for debugging in the browser console.
window.metahospital = { twin, ui, esc };
