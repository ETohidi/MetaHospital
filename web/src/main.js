// Boot, routing, the simulation controls' actions and the render loop. The app bar itself
// (breadcrumb + Simulation drawer) is drawn by ui/shell.js.
// Views live in ui/*.js and each exports render(container, ctx, { routeChanged }).

import { Twin } from "./engine/twin.js";
import { HOSPITAL_BY_ID, OWN_HOSPITAL, UNIT_BY_ID, UNIT_IDS } from "./data/places.js";
import { esc } from "./ui/dom.js";
import { createShell } from "./ui/shell.js";
import { loadRealData } from "./data/real.js";
import * as maps from "./ui/maps.js";
import * as worldView from "./ui/world.js";
import * as hospitalView from "./ui/hospital.js";
import * as unitView from "./ui/unit.js";

const AUTOPLAY_MS = { 1: 5000, 2: 2500, 4: 1250 };

const twin = new Twin();
/** Per-viewer UI state that survives re-renders (drafts, selections, toggles). */
const ui = { drafts: {}, autoplay: false, speed: 1 };
/** Real open data (World Bank, DIVI), loaded once at boot; views get it as ctx.data. */
const real = { state: "loading", data: null };

const $ = (sel) => document.querySelector(sel);
const view = $("#view");
const toasts = $("#toasts");
const topbar = $(".topbar");

// -- routes -------------------------------------------------------------------
// Only plain hash tokens survive the artifact viewer (letters, digits, . _ ~ -), so
// routes are "world", "germany", "berlin", "<hospitalId>" and "<hospitalId>.<unitId>".
// The old "earth" token redirects to "world"; an empty or unknown hash opens Germany.
// route.level is internal only (0 World, 2 Country, 3 Berlin, 4 Hospital, 5 Unit): the UI shows names.
export const routes = {
  world: "world",
  earth: "world",
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
    // a malformed %-escape falls through to the default instead of blanking the app
  }
  const token = rawToken.toLowerCase();
  if (token === "world") return { level: 0, token };
  if (token === "earth") return { level: 0, token: "world", redirect: true };
  if (token === "germany") return { level: 2, token };
  if (token === "berlin") return { level: 3, token };
  const [hid, uid] = token.split(".");
  const hosp = HOSPITAL_BY_ID[hid];
  if (hosp) {
    if (uid && hosp.isOwn && UNIT_BY_ID[uid]) return { level: 5, token, hospitalId: hid, unit: UNIT_BY_ID[uid] };
    return { level: 4, token: hid, hospitalId: hid };
  }
  // Owner decision: the site opens on Germany with the ministry lens.
  return { level: 2, token: "germany", redirect: token !== "" };
}

/** Rewrites a redirected token in place (#earth -> #world, junk -> #germany) without a history entry. */
function settleRoute(r) {
  if (!r.redirect) return r;
  try {
    history.replaceState(history.state, "", `#${r.token}`);
  } catch {
    // some embedded viewers forbid replaceState; the page still renders the right view
  }
  return r;
}

let route = settleRoute(parseRoute(location.hash));

function go(token) {
  if (location.hash.replace(/^#/, "") === token) return;
  location.hash = token;
}

window.addEventListener("hashchange", () => {
  route = settleRoute(parseRoute(location.hash));
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

function onSimAction(action) {
  if (action === "next") {
    const bundle = twin.tick();
    if (bundle && route.level < 4) toast(`${bundle.hourRange}: a new plan is waiting at ${OWN_HOSPITAL.name}.`);
    // On one-column layouts the plan sits below the KPIs; bring the new one into view.
    if (bundle && route.level >= 4 && matchMedia("(max-width: 1180px)").matches) {
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
    toast(`Bus accident (simulated): 20 casualties are arriving at the ${OWN_HOSPITAL.name} Emergency Department.`);
  } else if (action === "reset") {
    ui.drafts = {};
    twin.reset();
    toast(`The day restarted. It is ${twin.snapshot().time} again.`);
  }
}

const shell = createShell({ ui, routes, onAction: onSimAction, onToggle: () => updateSticky() });

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
const VIEWS = { 0: worldView, 2: maps, 3: maps, 4: hospitalView, 5: unitView };
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
  shell.render(route, snap);
  updateSticky();

  if (!routeChanged && isBusy()) {
    deferred = true; // don't yank a dropdown, text field or half-finished click from the viewer
    restoreFocus(focused);
    return;
  }
  deferred = false;
  const ctx = {
    twin,
    snap,
    route,
    routes,
    go,
    ui,
    toast,
    data: real.data,
    dataState: real.state,
    rerender: () => render(),
  };
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

// -- sticky header: anchors scroll in below it (--sticky-h) ---------------------------------------
function updateSticky() {
  document.documentElement.style.setProperty("--sticky-h", `${topbar.offsetHeight}px`);
}
if (typeof ResizeObserver === "function") new ResizeObserver(updateSticky).observe(topbar);

view.addEventListener("focusout", renderIfDeferred);

twin.subscribe(() => render());
render({ routeChanged: true });

// Real data loads after the first paint; the current view re-renders with it once it arrives.
Promise.resolve()
  .then(() => loadRealData())
  .then(
    (data) => {
      real.data = data ?? null;
      real.state = data ? "ready" : "failed";
    },
    (err) => {
      real.state = "failed";
      console.warn("MetaHospital: real data did not load", err);
    },
  )
  .then(() => render());

// Exposed for debugging in the browser console.
window.metahospital = { twin, ui, esc, real };
