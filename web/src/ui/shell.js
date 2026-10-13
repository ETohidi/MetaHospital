// The app bar: logo, breadcrumb of places (with the level name under each place, never a number)
// and the collapsible "Simulation" drawer that holds the demo-twin controls (Next hour, Play,
// speed, Bus accident, Restart, seed). main.js owns the timers and the twin; this file only draws
// the bar and reports clicks through onAction(action).

import { HOSPITAL_BY_ID, OWN_HOSPITAL } from "../data/places.js";
import { html, raw } from "./dom.js";

const ICONS = {
  sim: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.5V8l2.4 1.6"/></svg>',
  next: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M3 2.5v11l7-5.5zM11 2.5h2v11h-2z"/></svg>',
  play: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 2.5v11l9-5.5z"/></svg>',
  pause:
    '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 2.5h3v11H4zM9 2.5h3v11H9z"/></svg>',
  alert:
    '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.5l7 12.5H1zM7.2 6v4h1.6V6zm0 5.2v1.6h1.6v-1.6z"/></svg>',
  restart:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 8a5 5 0 1 0 1.6-3.7"/><path d="M3 2.5v3h3"/></svg>',
};

const OPEN_KEY = "metahospital.simOpen";

function loadOpen() {
  try {
    return localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}
function saveOpen(open) {
  try {
    localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
    // private windows may block storage; the drawer just starts closed next time
  }
}

/** Breadcrumb steps for a route: World / Germany / Berlin / <hospital> / <unit>. */
export function ladderSteps(route, routes) {
  const hosp = route.hospitalId ? HOSPITAL_BY_ID[route.hospitalId] : null;
  return [
    { level: 0, name: "World", scale: "World", token: routes.world },
    { level: 2, name: "Germany", scale: "Country", token: routes.germany },
    { level: 3, name: "Berlin", scale: "Land · City", token: routes.berlin },
    hosp
      ? { level: 4, name: hosp.name, scale: "Hospital · demo twin", token: routes.hospital(hosp.id) }
      : { level: 4, name: "Hospital", scale: "not chosen", pending: true },
    route.unit
      ? { level: 5, name: route.unit, scale: "Unit", token: routes.unit(route.unit) }
      : { level: 5, name: "Unit", scale: "not chosen", pending: true },
  ];
}

/**
 * Builds the shell around the existing #ladder, #sim-toggle, #simdrawer, #simbar, #statusline,
 * #emergency and #surge-live elements of index.html.
 * @param {{ui: object, routes: object, onAction: (action: string) => void, onToggle?: () => void}} opts
 */
export function createShell({ ui, routes, onAction, onToggle }) {
  const $ = (sel) => document.querySelector(sel);
  const ladder = $("#ladder");
  const crumbs = ladder.closest(".crumbs");
  const toggle = $("#sim-toggle");
  const drawer = $("#simdrawer");
  const simbar = $("#simbar");
  const statusline = $("#statusline");
  const emergency = $("#emergency");
  const surgeLive = $("#surge-live");

  ui.simOpen = loadOpen();
  let simbarKey = null;
  let clockTime = null;
  let clockDay = null;
  let toggleKey = null;
  let ladderKey = null;
  let surgeWas = null;

  function setOpen(open) {
    ui.simOpen = open;
    saveOpen(open);
    drawer.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    onToggle?.();
  }
  setOpen(ui.simOpen);

  toggle.addEventListener("click", () => setOpen(!ui.simOpen));
  simbar.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-sim]");
    if (btn) onAction(btn.dataset.sim);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && ui.simOpen && drawer.contains(document.activeElement)) {
      setOpen(false);
      toggle.focus();
    }
  });

  function renderLadder(route) {
    const steps = ladderSteps(route, routes);
    const key = steps.map((s) => `${s.name}|${s.pending ? 1 : 0}`).join("/") + route.level;
    if (key === ladderKey) return;
    ladderKey = key;
    ladder.innerHTML = String(
      html`${steps.map((s, i) => {
        const current = s.level === route.level;
        // On a phone only the parent and the current place show; the rest are one tap up the chain.
        const here = steps.findIndex((x) => x.level === route.level);
        const cls = i < here - 1 ? "is-far" : i === here - 1 ? "is-up" : "";
        const scale = s.scale === s.name ? "" : html`<span class="step-scale">${s.scale}</span>`;
        const inner = html`<span class="step-name">${s.name}</span>${scale}`;
        if (s.pending) return html`<li class="is-pending"><span class="step is-pending">${inner}</span></li>`;
        return html`<li${cls ? raw(` class="${cls}"`) : ""}><a href="#${s.token}"${current ? raw(' aria-current="page"') : ""}>${inner}</a></li>`;
      })}`,
    );
    // On a phone the breadcrumb scrolls sideways; keep the current place in view.
    const cur = ladder.querySelector('[aria-current="page"]');
    if (cur && crumbs) crumbs.scrollLeft = Math.max(0, cur.offsetLeft + cur.offsetWidth - crumbs.clientWidth + 8);
  }

  function renderToggle(snap) {
    const day = snap.dayTime.split(" ")[0];
    const tz = snap.timeZoneLabel ?? "German time";
    const pending = Boolean(snap.pendingBundle);
    const key = `${snap.time}|${day}|${pending}|${snap.surge ? 1 : 0}`;
    if (key === toggleKey) return;
    toggleKey = key;
    const what = pending ? "a plan is waiting" : "no plan waiting";
    toggle.setAttribute("aria-label", `Simulation of the demo twins, ${day} ${snap.time} ${tz}, ${what}`);
    toggle.title = `Twin time: ${tz} (Europe/Berlin)`;
    toggle.innerHTML = String(
      html`${raw(ICONS.sim)}<span class="sim-label">Simulation</span>
        <span class="sim-time"><span class="sim-day">${day.slice(0, 3)} </span>${snap.time}</span>
        ${pending || snap.surge ? html`<span class="sim-dot" title="${snap.surge ? "Emergency running" : "A plan awaits a decision"}"></span>` : ""}
        <span class="sim-chev" aria-hidden="true"></span>`,
    );
  }

  // The clock is built once so its live region announces only real hour changes; the buttons
  // are rebuilt only when their state changes, so a focused button survives an ordinary tick.
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
    const day = `${snap.dayTime.split(" ")[0].slice(0, 3)} ${snap.date ?? ""} · ${snap.timeZoneLabel ?? "German time"}`.replace("  ", " ");
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
        ${raw(ui.autoplay ? ICONS.pause : ICONS.play)} <span class="btn-label">${ui.autoplay ? "Pause" : "Play"}</span>
      </button>
      <button class="btn btn-ghost" id="btn-speed" data-sim="speed" title="Autoplay speed">${ui.speed}×</button>
      <button
        class="btn btn-danger"
        id="btn-surge"
        data-sim="surge"
        title="20 casualties arrive at the Emergency Department"
      >
        ${raw(ICONS.alert)} Bus accident
      </button>
      <button class="btn btn-ghost" id="btn-reset" data-sim="reset" title="Restart the simulation at the current hour in Germany">
        ${raw(ICONS.restart)} <span class="btn-label">Restart</span>
      </button>
    `);
  }

  function renderStatus(snap) {
    const pending = snap.pendingBundle;
    // Announce the emergency once, when it starts; the visible strip below is not a live region.
    if (snap.surge && !surgeWas) surgeLive.textContent = `Emergency at ${OWN_HOSPITAL.name}: ${snap.surge}.`;
    if (!snap.surge) surgeLive.textContent = "";
    surgeWas = snap.surge;
    statusline.innerHTML = String(html`
      <span
        class="chip chip-plain"
        title="The demo twins are fictional hospitals; every patient and bed in them is simulated"
        >Simulated · demo twins only</span
      >
      <span class="faint status-seed" title="The same seed always replays the same day">seed ${snap.seed}</span>
      ${
        pending
          ? html`<a class="chip chip-accent" href="#${routes.hospital(OWN_HOSPITAL.id)}"
              >Plan for ${pending.hourRange} awaits a decision</a
            >`
          : html`<span class="chip">No plan waiting</span>`
      }
    `);
    emergency.hidden = !snap.surge;
    emergency.innerHTML = snap.surge
      ? String(
          html`<div>
            <span
              >Simulated<span class="em-long"> emergency at ${OWN_HOSPITAL.name} (demo twin)</span>: ${snap.surge}</span
            >
            <span>${snap.surgeTicksRemaining}h left</span>
            <a href="#${routes.hospital(OWN_HOSPITAL.id)}">Open<span class="em-long"> the hospital</span></a>
          </div>`,
        )
      : "";
  }

  return {
    render(route, snap) {
      renderLadder(route);
      renderToggle(snap);
      renderSimbar(snap);
      renderStatus(snap);
    },
    setOpen,
  };
}
