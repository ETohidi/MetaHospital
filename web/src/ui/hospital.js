// Hospital level. Our own hospital (a fictional demo twin) gets the director's screen: page
// head, KPI strip, departments, bed board, team conversation and family messages in the
// main column, and the rail with the plan decision, what we share and what peers share. A
// neighbouring demo twin shows what it reports to the Regional coordinator.
//
// The page anatomy (head, KPI strip, badges, sources) comes from page.js, the levels panel from
// levels.js. The plan decision card and the bed board are shared with the unit page.

import { HOSPITAL_BY_ID, OWN_HOSPITAL, UNITS, UNIT_LABEL } from "../data/places.js";
import { actionLabel } from "../engine/labels.js";
import { ACUITY_LABEL, acuity, chip, confBar, html, pct, plural, raw, UTIL_LABEL, utilTone } from "./dom.js";
import { levelsPanel } from "./levels.js";
import { kpiStrip, pageHead, pill, prov, simBadge, sourcesFooter } from "./page.js";

// =====================================================================================
// Twin figures shared by the hospital and unit pages
// =====================================================================================
const usedFraction = (u) => (u.bedsStaffed ? u.bedsOccupied / u.bedsStaffed : u.bedsOccupied ? 2 : 0);
const freeOf = (u) => Math.max(0, u.bedsStaffed - u.bedsOccupied);
const closedOf = (u) => Math.max(0, u.bedsTotal - u.bedsStaffed);
const overOf = (u) => Math.max(0, u.bedsOccupied - u.bedsStaffed);

function totals(units) {
  const t = { occupied: 0, staffed: 0, total: 0, free: 0, closed: 0, over: 0 };
  for (const name of UNITS) {
    const u = units[name];
    t.occupied += u.bedsOccupied;
    t.staffed += u.bedsStaffed;
    t.total += u.bedsTotal;
    t.free += freeOf(u);
    t.closed += closedOf(u);
    t.over += overOf(u);
  }
  t.fraction = t.staffed ? t.occupied / t.staffed : 1;
  return t;
}

/** Overall status pill text and tone for an occupancy fraction. */
export function utilStatus(fraction, what = "of usable beds") {
  const tone = utilTone(fraction);
  return { text: `${UTIL_LABEL[tone]} · ${pct(fraction)} ${what}`, tone };
}

/** Peer status per capability, as IVENA and the DIVI map show it: no exact number. */
export function capabilityStatus(u) {
  const free = freeOf(u);
  const closed = closedOf(u);
  if (free <= 0) return { word: "Not available", tone: "crit", reason: closed ? "staff" : "space" };
  if (free <= Math.max(1, Math.round(u.bedsStaffed * 0.1))) return { word: "Limited", tone: "warn", reason: closed ? "staff" : "space" };
  return { word: "Available", tone: "ok", reason: "" };
}

/** ED patients waiting for a bed upstairs (they are in the ICU and Ward queues). */
const edBoarders = (snap) => UNITS.filter((u) => u !== "ED").reduce((n, u) => n + snap.units[u].queue.filter((q) => q.from === "ED").length, 0);

// =====================================================================================
// Plan decision (shared with the unit page): a compact request item with Approve / Reject
// on top and the actions, safety check and offers folded away.
// =====================================================================================
const OTHER_REASON = "Other (type a reason)";
const REJECT_REASONS = [
  "Not enough staff for this",
  "Patient too unstable to move",
  "Keep beds free for the emergency",
  "Wrong priority order",
  "A nearby hospital should take this patient",
  OTHER_REASON,
];

const STATUS_TONE = { approved: "ok", rejected: "crit", expired: "mute" };
const STATUS_LABEL = { approved: "Approved", rejected: "Rejected", expired: "Expired", pending: "Waiting" };

const SHIELD =
  '<svg class="hosp-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.2l5.6 2v4.3c0 3.4-2.3 6.1-5.6 7.3-3.3-1.2-5.6-3.9-5.6-7.3V3.2z" fill="currentColor"/><path d="M6 6l4 4M10 6l-4 4" fill="none" stroke="var(--surface)" stroke-width="1.6" stroke-linecap="round"/></svg>';

/** Per-viewer state of the hospital page, also used by the unit page. */
export function hospState(ctx) {
  ctx.ui.drafts ??= {};
  return (ctx.ui.hospital ??= { selected: null, arrivals: null, showTable: false, planOpen: false });
}

function draftFor(ctx, bundleId) {
  return ctx.ui.drafts[bundleId] ?? { choice: REJECT_REASONS[0], custom: "" };
}

function reasonOf(draft) {
  return draft.choice === OTHER_REASON ? draft.custom.trim() : draft.choice;
}

/** "3 ED → ICU · 2 ED → Ward · ED diverted": what the plan does, in one line. */
function moveLine(rows) {
  const counts = new Map();
  for (const r of rows) {
    const key = r.patientId === "—" ? `${r.unit}: ${r.movement}` : r.movement;
    counts.set(key, (counts.get(key) ?? 0) + (r.patientId === "—" ? 0 : 1));
  }
  return [...counts].map(([k, n]) => (n ? `${n} ${k}` : k)).join(" · ");
}

function groupByAuthor(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.author)) groups.set(r.author, []);
    groups.get(r.author).push(r);
  }
  return [...groups].map(([author, items]) => ({ author, items }));
}

function planItem(r) {
  const unitLevel = r.patientId === "—";
  const who = unitLevel
    ? html`<span class="hosp-pa-who" title="Unit-level action, not about one patient">Whole ${r.unit}</span>`
    : html`<span class="hosp-pa-who">${r.patientId}</span> ${acuity(r.acuity)} <span class="hosp-pa-cond">${r.condition}</span>`;
  return html`<li class="hosp-pa${unitLevel ? " is-unit" : ""}">
    <div class="hosp-pa-top">${who} <span class="hosp-pa-sep" aria-hidden="true">·</span> <span class="hosp-pa-move">${r.movement}</span></div>
    <div class="hosp-pa-why"><span class="hosp-pa-reason">${r.reason}</span> ${confBar(r.confidence)} <span class="hosp-pa-by">by ${r.author}</span></div>
  </li>`;
}

function planList(rows, focusUnit) {
  if (!rows.length) return html`<p class="muted">No actions proposed this hour.</p>`;
  return html`
    <div class="hosp-plan-list" role="group" aria-label="Proposed actions">
      ${groupByAuthor(rows).map(
        (g) => html`<div class="hosp-pa-group${focusUnit && g.items.some((r) => r.unit === focusUnit) ? " is-focus" : ""}">
          <h4 class="hosp-pa-head">${g.author} <span class="hosp-pa-count">· ${plural(g.items.length, "action")}</span></h4>
          <ol class="hosp-pa-list">${g.items.map(planItem)}</ol>
        </div>`,
      )}
    </div>
  `;
}

function beforeAfter(b) {
  return html`
    <dl class="hosp-delta" aria-label="Patients per unit now, and if you approve">
      ${UNITS.map((u) => {
        const d = b.after[u] - b.before[u];
        const sign = d > 0 ? `+${d}` : d < 0 ? `−${-d}` : "±0";
        return html`<div><dt>${u}</dt><dd><span class="num">${b.before[u]} → ${b.after[u]}</span> <span class="faint num">${sign}</span></dd></div>`;
      })}
    </dl>
  `;
}

function blockedList(safety) {
  const blocked = safety.filter((s) => s.blocked);
  if (!blocked.length) return "";
  return html`
    <div class="hosp-blocked">
      <h4>Safety check blocked</h4>
      <ul>
        ${blocked.map((s) => {
          const what = actionLabel(s.action.type);
          const who = s.action.patientId ? ` of ${s.action.patientId}` : s.action.hospital ? ` to ${s.action.hospital}` : "";
          return html`<li>${raw(SHIELD)}<div><b>${s.author}</b>: ${what}${who}<br /><span class="hosp-rule">${s.rule ?? "Blocked by a safety rule."}</span></div></li>`;
        })}
      </ul>
    </div>
  `;
}

/** Offers from the neighbouring demo twins: the one place a peer's exact number appears. */
function offersList(allCapacity, snap) {
  const capacity = allCapacity.filter((c) => c.hospital !== OWN_HOSPITAL.name);
  if (!capacity.length) return "";
  return html`
    <div class="hosp-nearby">
      <h4>Offers from neighbouring hospitals ${simBadge(snap)}</h4>
      <p class="faint hosp-caption">Answers to the Regional coordinator's request. Exact numbers appear only inside an offer.</p>
      <ul>
        ${capacity.map(
          (c) => html`<li>
            <span><b>${c.hospital}</b> can take ICU ${c.canAccept.ICU} · Ward ${c.canAccept.Ward} until ${c.validUntil}</span>
            ${confBar(c.confidence)}
          </li>`,
        )}
      </ul>
    </div>
  `;
}

/** The waiting plan as a request item: decision first, details folded. */
export function decisionItem(ctx, b, { focusUnit = null } = {}) {
  const st = hospState(ctx);
  const draft = draftFor(ctx, b.id);
  const reason = reasonOf(draft);
  const other = draft.choice === OTHER_REASON;
  const conf = b.overallConfidence;
  const blocked = b.safety.filter((s) => s.blocked).length;
  const mine = focusUnit ? b.rows.filter((r) => r.unit === focusUnit).length : null;
  return html`
    <li class="req is-plan">
      <div class="req-top">
        <span class="req-from">Your unit planners · Coordinator</span>
        ${
          blocked
            ? pill(`Safety check blocked ${blocked}`, "warn")
            : pill(b.safety.length ? "Safety check passed" : "Nothing to check", "ok")
        }
      </div>
      <h3 class="req-what" id="hosp-plan-title">Plan for ${b.hourRange}: ${b.rows.length ? plural(b.rows.length, "action") : "no actions"}</h3>
      ${b.rows.length ? html`<p class="req-why">${moveLine(b.rows)}</p>` : ""}
      ${focusUnit ? html`<p class="req-why faint">${mine ? `${plural(mine, "action")} for ${focusUnit}.` : `Nothing for ${focusUnit} in this plan.`}</p>` : ""}
      ${beforeAfter(b)}
      ${
        conf === null || conf === undefined
          ? ""
          : html`<div class="hosp-conf"><span>Least certain action</span> ${confBar(conf)}
              ${conf < 0.5 ? chip("Review carefully", "warn", { title: "The least certain action is below 0.50" }) : ""}</div>`
      }
      <div class="hosp-decide">
        <button type="button" class="btn btn-primary hosp-approve" data-action="approve" data-bundle="${b.id}" data-focus-key="approve-${b.id}">Approve plan</button>
        <form class="hosp-reject" data-reject="${b.id}">
          <label class="hosp-label" for="reject-reason-${b.id}">Or reject, with a reason for the planners</label>
          <select class="select" id="reject-reason-${b.id}" data-draft="choice" data-bundle="${b.id}" data-focus-key="reason-${b.id}">
            ${REJECT_REASONS.map((r) => html`<option value="${r}"${r === draft.choice ? raw(" selected") : ""}>${r}</option>`)}
          </select>
          <button type="submit" class="btn btn-danger" data-focus-key="reject-${b.id}"${reason ? "" : raw(" disabled")}>Reject</button>
          <input class="input" id="reject-custom-${b.id}" data-draft="custom" data-bundle="${b.id}" data-focus-key="custom-${b.id}" type="text"
            maxlength="200" autocomplete="off" placeholder="Type a reason" aria-label="Your reason"
            value="${draft.custom}"${other ? "" : raw(" hidden")} />
        </form>
      </div>
      <details class="hosp-more"${st.planOpen ? raw(" open") : ""}>
        <summary data-action="plan-more" data-focus-key="plan-more">Actions, safety check and offers</summary>
        <div class="hosp-more-body">
          ${planList(b.rows, focusUnit)}
          <p class="hosp-summary"><span class="actor">Coordinator:</span> ${b.summary}</p>
          ${blockedList(b.safety)}
          ${offersList(b.nearbyCapacity, ctx.snap)}
        </div>
      </details>
    </li>
  `;
}

function noPlanItem(twin) {
  const decided = twin.bundles().filter((b) => b.status !== "pending").slice(0, 3);
  return html`
    <li class="req">
      <div class="req-top"><span class="req-from">Your unit planners · Coordinator</span>${pill("Nothing waiting", "mute")}</div>
      <h3 class="req-what" id="hosp-plan-title">No plan is waiting</h3>
      <p class="req-why">The unit planners propose the next one when the simulation moves on an hour.</p>
      ${
        decided.length
          ? html`<ul class="hosp-history" aria-label="Recent plans">
              ${decided.map(
                (b) => html`<li>
                  <span class="num">${b.hourRange}</span>
                  ${pill(STATUS_LABEL[b.status] ?? b.status, STATUS_TONE[b.status] ?? "mute")}
                  <span class="faint">${b.decidedTime ? `at ${b.decidedTime}` : ""}</span>
                  ${b.status === "rejected" && b.reason ? html`<span class="hosp-history-reason">“${b.reason}”</span>` : ""}
                </li>`,
              )}
            </ul>`
          : ""
      }
    </li>
  `;
}

/** Alerts and requests for the own hospital: the plan, the emergency, unit asks. */
export function requestsCard(ctx, { focusUnit = null } = {}) {
  const { snap, twin } = ctx;
  const b = snap.pendingBundle;
  const items = [b ? decisionItem(ctx, b, { focusUnit }) : noPlanItem(twin)];
  if (snap.surge) {
    items.push(html`<li class="req">
      <div class="req-top"><span class="req-from">Emergency department · alarm</span>${pill(`${snap.surgeTicksRemaining} h left`, "crit")}</div>
      <div class="req-what">Emergency: ${snap.surge}</div>
      <p class="req-why">Casualties arrive at the ED over the next hours. The planners make room upstairs.</p>
    </li>`);
  }
  if (snap.edDivertHoursRemaining > 0) {
    items.push(html`<li class="req">
      <div class="req-top"><span class="req-from">Approved plan · dispatch</span>${pill(`${snap.edDivertHoursRemaining} h left`, "warn")}</div>
      <div class="req-what">Ambulances diverted</div>
      <p class="req-why">The ED takes about half its usual ambulance arrivals.</p>
    </li>`);
  }
  for (const r of snap.pendingRequests ?? []) {
    items.push(html`<li class="req">
      <div class="req-top"><span class="req-from">Your ${r.unit} · bed request</span>${pill(`Urgency ${r.urgency}`, r.urgency === "high" ? "warn" : "mute")}</div>
      <div class="req-what">${r.unit} asks for ${plural(r.beds, "bed")}</div>
    </li>`);
  }
  const count = (b ? 1 : 0) + (snap.surge ? 1 : 0) + (snap.edDivertHoursRemaining > 0 ? 1 : 0) + (snap.pendingRequests?.length ?? 0);
  return html`
    <section class="pane pane-req" id="requests" aria-labelledby="req-title">
      <header class="pane-head">
        <div>
          <h2 id="req-title">Requests${count ? html` <span class="pane-count">${count}</span>` : ""}</h2>
          <p>From your unit planners, the city and dispatch</p>
        </div>
        ${simBadge(snap)}
      </header>
      <ul class="req-list">${items}</ul>
    </section>
  `;
}

// -- decision handlers (hospital and unit page) ------------------------------------------
/** Handles Approve and the details toggle; true if the click was one of them. */
export function handleDecisionClick(event, ctx) {
  const target = event.target;
  const approve = target.closest("[data-action='approve']");
  if (approve) {
    approvePlan(ctx, Number(approve.dataset.bundle));
    return true;
  }
  const more = target.closest("[data-action='plan-more']");
  if (more) {
    // The click comes before the browser toggles <details>, so the new state is the opposite.
    hospState(ctx).planOpen = !more.parentElement.open;
    return true;
  }
  return false;
}

function approvePlan(ctx, bundleId) {
  const { twin } = ctx;
  const before = twin.family();
  let bundle;
  try {
    bundle = twin.decide(bundleId, "approve");
  } catch (err) {
    if (!onExpired(ctx, bundleId)) ctx.toast(err.message);
    return;
  }
  delete ctx.ui.drafts[bundleId];
  // Family messages are stamped with the hour of the approval, which is the plan's hour.
  const atPlanHour = (list) => list.filter((m) => m.tick === bundle.tick).length;
  const sent = Math.max(0, atPlanHour(twin.family()) - atPlanHour(before));
  ctx.toast(sent ? `Plan approved. ${plural(sent, "family message")} went out.` : "Plan approved.");
}

/** Keep the rejection draft in ctx.ui and update the form in place (re-renders wait while a field has focus). */
export function onDraftEdit(event, ctx) {
  const field = event.target.closest("[data-draft]");
  if (!field) return;
  const id = Number(field.dataset.bundle);
  const draft = { ...draftFor(ctx, id) };
  if (field.dataset.draft === "choice") draft.choice = field.value;
  else draft.custom = field.value;
  ctx.ui.drafts[id] = draft;

  const form = field.closest("form");
  if (!form) return;
  const custom = form.querySelector("[data-draft='custom']");
  const submit = form.querySelector("button[type='submit']");
  const other = draft.choice === OTHER_REASON;
  if (custom) {
    custom.hidden = !other;
    if (other && field.dataset.draft === "choice" && event.type === "change") custom.focus();
  }
  if (submit) submit.disabled = !reasonOf(draft);
}

/**
 * The plan expired (autoplay moved on) before the viewer decided: say so and carry a
 * typed rejection reason over to the plan that is waiting now. False if it didn't expire.
 */
function onExpired(ctx, bundleId) {
  const { twin } = ctx;
  if (twin.bundles().find((b) => b.id === bundleId)?.status !== "expired") return false;
  const draft = ctx.ui.drafts[bundleId];
  delete ctx.ui.drafts[bundleId];
  const next = twin.snapshot().pendingBundle;
  const keep = draft && reasonOf(draft);
  if (keep && next && !ctx.ui.drafts[next.id]) ctx.ui.drafts[next.id] = draft;
  ctx.toast(
    keep
      ? "This plan expired before you decided. Your reason is kept for the next plan."
      : "This plan expired before you decided.",
  );
  ctx.rerender();
  return true;
}

export function onRejectSubmit(event, ctx) {
  const form = event.target.closest("form[data-reject]");
  if (!form) return;
  event.preventDefault();
  const id = Number(form.dataset.reject);
  const reason = reasonOf(draftFor(ctx, id));
  if (!reason) {
    ctx.toast("Type a reason first, so the planners know what to change.");
    return;
  }
  try {
    ctx.twin.decide(id, "reject", reason);
  } catch (err) {
    if (!onExpired(ctx, id)) ctx.toast(err.message);
    return;
  }
  delete ctx.ui.drafts[id];
  ctx.toast(`Plan rejected: ${reason}`);
}

// =====================================================================================
// Bed board (shared with the unit page)
// =====================================================================================
const ARRIVAL_MS = 1600; // matches the hosp-arrive animation in hospital.css

/** Patients who just moved in with the last approval get a one-shot highlight. */
function arrivalState(ctx) {
  const transfers = ctx.snap.recentTransfers;
  const st = hospState(ctx);
  if (!transfers.length) {
    st.arrivals = null;
    return { ids: new Set(), delay: 0 };
  }
  const key = `${ctx.snap.seed}:${transfers.map((t) => `${t.patientId}>${t.to}`).join(",")}`;
  if (st.arrivals?.key !== key) st.arrivals = { key, at: Date.now() };
  const elapsed = Date.now() - st.arrivals.at;
  if (elapsed >= ARRIVAL_MS) return { ids: new Set(), delay: 0 };
  return { ids: new Set(transfers.map((t) => `${t.to}:${t.patientId}`)), delay: elapsed };
}

function bedLegend(snap, units) {
  const overflow = units.some((u) => snap.units[u].bedsStaffed > snap.units[u].bedsTotal);
  return html`
    <div class="legend hosp-legend">
      ${[1, 2, 3, 4, 5].map((a) => html`<span><i class="swatch hosp-a${a}"></i>${a} ${ACUITY_LABEL[a]}</span>`)}
      <span><i class="swatch hosp-sw-free"></i>Free</span>
      <span><i class="swatch hosp-sw-closed"></i>Closed: no staff</span>
      ${overflow ? html`<span><i class="swatch hosp-sw-free hosp-sw-overflow"></i>Overflow bed</span>` : ""}
      <span><i class="swatch hosp-sw-surge"></i>Emergency arrival</span>
      <span><i class="swatch hosp-sw-hallway"></i>Hallway, no bed</span>
    </div>
  `;
}

function patientLabel(p) {
  return `${p.id} · ${p.condition} · acuity ${p.acuity} · leaves ~${p.expectedDischargeTime}`;
}

function patientCell(p, { hallway, arrival, delay, selected }) {
  const cls = ["hosp-bed", "is-filled", `hosp-a${p.acuity}`, hallway && "is-hallway", p.surge && "is-surge", arrival && "is-arrival", selected && "is-selected"]
    .filter(Boolean)
    .join(" ");
  const where = hallway ? "Hallway" : `Bed ${p.bed}`;
  const extra = [p.surge && "emergency arrival", arrival && "just moved in"].filter(Boolean).join(", ");
  const label = `${where}: ${patientLabel(p)}${extra ? ` (${extra})` : ""}`;
  const style = arrival && delay ? raw(` style="animation-delay:-${Math.round(delay)}ms"`) : "";
  return html`<button type="button" class="${cls}" title="${label}" aria-label="${label}" aria-pressed="${selected ? "true" : "false"}"
    data-patient="${p.id}" data-focus-key="bed-${p.id}"${style}></button>`;
}

function unitBlock(unit, ctx, arrivals, selected, { links }) {
  const { snap, routes } = ctx;
  const u = snap.units[unit];
  const patients = snap.patients.filter((p) => p.unit === unit);
  const byBed = new Map();
  const hallway = [];
  for (const p of patients) {
    if (p.bed !== null && p.bed >= 1 && p.bed <= u.bedsStaffed && !byBed.has(p.bed)) byBed.set(p.bed, p);
    else hallway.push(p);
  }
  const slots = Math.max(u.bedsTotal, u.bedsStaffed);
  const cellOpts = (p, isHallway) => ({
    hallway: isHallway,
    arrival: arrivals.ids.has(`${unit}:${p.id}`),
    delay: arrivals.delay,
    selected: selected?.id === p.id,
  });

  const cells = [];
  for (let slot = 1; slot <= slots; slot++) {
    const p = byBed.get(slot);
    if (p) cells.push(patientCell(p, cellOpts(p, false)));
    else if (slot > u.bedsStaffed) {
      cells.push(html`<span class="hosp-bed is-closed" role="img" title="Closed: no staff on shift" aria-label="Bed ${slot}: closed, no staff on shift"></span>`);
    } else {
      const overflow = slot > u.bedsTotal;
      const label = overflow ? `Overflow bed ${slot}: free` : `Bed ${slot}: free`;
      cells.push(html`<span class="hosp-bed is-free${overflow ? " is-overflow" : ""}" role="img" title="${label}" aria-label="${label}"></span>`);
    }
  }

  const next = patients.reduce((best, p) => (!best || p.expectedDischargeTick < best.expectedDischargeTick ? p : best), null);
  const tone = utilTone(usedFraction(u));
  const queue = u.queue.length;
  const unitHref = `#${routes.unit(unit)}`;
  const showDetail = selected && selected.unit === unit;

  return html`
    <article class="hosp-unit is-${tone}" aria-labelledby="hosp-unit-${unit}">
      <header class="hosp-unit-head">
        <h3 id="hosp-unit-${unit}">${
          links ? html`<a href="${unitHref}" data-focus-key="unit-${unit}">${unit}</a>` : unit
        } <span class="hosp-unit-long">${UNIT_LABEL[unit]}</span></h3>
        <p class="hosp-unit-counts"><b>${u.bedsOccupied}</b> in use · ${u.bedsStaffed} usable today · ${u.bedsTotal} beds</p>
        ${links ? html`<a class="btn btn-ghost hosp-unit-open" href="${unitHref}" aria-label="Open ${unit}: ${UNIT_LABEL[unit]}" data-focus-key="open-${unit}">Open ${unit} ›</a>` : ""}
      </header>
      <div class="hosp-unit-facts">
        <span>${queue ? `${queue} waiting to move in` : "Nobody waiting to move in"}</span>
        <span>${next ? `Next discharge ~${next.expectedDischargeTime}` : "No discharges due"}</span>
        ${u.recentRejections.length ? html`<span class="hosp-remembers">Planner remembers: “${u.recentRejections.at(-1)}”</span>` : ""}
      </div>
      <div class="hosp-beds" role="group" aria-label="${unit} beds">${cells}</div>
      ${
        hallway.length
          ? html`<div class="hosp-hallway">
              <span class="hosp-hallway-count">${hallway.length} in the hallway</span>
              <div class="hosp-beds hosp-beds-hallway" role="group" aria-label="${unit} patients in the hallway">
                ${hallway.map((p) => patientCell(p, cellOpts(p, true)))}
              </div>
            </div>`
          : ""
      }
      ${showDetail ? bedDetail(selected, snap) : ""}
    </article>
  `;
}

function bedDetail(p, snap) {
  const waiting = UNITS.map((u) => ({ unit: u, item: snap.units[u].queue.find((q) => q.patientId === p.id) })).find((x) => x.item);
  const where = p.bed !== null && p.bed <= snap.units[p.unit].bedsStaffed ? `Bed ${p.bed}` : "Hallway";
  return html`
    <div class="hosp-detail">
      <div>
        <b>${where}: ${p.id}</b> ${acuity(p.acuity)}
        <span class="muted">${p.condition}, acuity ${p.acuity} (${ACUITY_LABEL[p.acuity] ?? "unknown"}), leaves ~${p.expectedDischargeTime}</span>
        ${p.surge ? chip("Emergency arrival", "crit") : ""}
        ${waiting ? html`<span class="muted">Waiting to move to ${waiting.unit} for ${plural(waiting.item.waitingTicks, "hour")}.</span>` : ""}
      </div>
      <button type="button" class="btn btn-ghost" data-action="bed-close" data-focus-key="bed-close" aria-label="Close patient details">Close</button>
    </div>
  `;
}

/** The bed board for some units: one square per bed, patients are buttons. */
export function bedBoard(ctx, units = UNITS, { links = true, title = "Bed board" } = {}) {
  const st = hospState(ctx);
  const arrivals = arrivalState(ctx);
  const selected = ctx.snap.patients.find((p) => p.id === st.selected) ?? null;
  if (!selected) st.selected = null;
  return html`
    <section class="pane" aria-labelledby="hosp-board-title">
      <header class="pane-head">
        <div>
          <h2 id="hosp-board-title">${title}</h2>
          <p>One square per bed. Point at or tap a patient's bed to see who is in it.</p>
        </div>
        ${simBadge(ctx.snap)}
      </header>
      <div class="pane-body hosp-board">
        ${bedLegend(ctx.snap, units)}
        ${units.map((unit) => unitBlock(unit, ctx, arrivals, selected, { links }))}
      </div>
    </section>
  `;
}

/** Bed selection and the detail's Close button; true if handled. */
export function handleBedClick(event, ctx) {
  const st = hospState(ctx);
  if (event.target.closest("[data-action='bed-close']")) {
    st.selected = null;
    ctx.rerender();
    return true;
  }
  const cell = event.target.closest("[data-patient]");
  if (cell) {
    const id = cell.dataset.patient;
    st.selected = st.selected === id ? null : id;
    ctx.rerender();
    return true;
  }
  return false;
}

// =====================================================================================
// Entry point
// =====================================================================================
export function render(container, ctx) {
  const hosp = HOSPITAL_BY_ID[ctx.route.hospitalId];
  hospState(ctx);
  if (!hosp) {
    container.innerHTML = String(html`<div class="card"><p>This hospital is not part of the network.</p>
      <p><a href="#${ctx.routes.berlin}" data-focus-key="back-berlin">Back to Berlin</a></p></div>`);
    return;
  }
  if (hosp.isOwn) renderOwn(container, ctx, hosp);
  else renderNeighbour(container, ctx, hosp);
}

// =====================================================================================
// Own hospital: the director's screen
// =====================================================================================
const LOG_LIMIT = 80;

/** Hospital-wide occupancy per history hour (sum over units), for the sparkline. */
function occupancySeries(twin) {
  const hist = UNITS.map((u) => twin.unitHistory(u).history.slice(-24));
  const n = Math.min(...hist.map((h) => h.length));
  const out = [];
  for (let i = 0; i < n; i++) {
    let inUse = 0;
    let usable = 0;
    for (const h of hist) {
      const row = h[h.length - n + i];
      inUse += row.inUse;
      usable += row.usable;
    }
    out.push(usable ? inUse / usable : 1);
  }
  return out;
}

/** Projected change in patients over the projection window, summed over units. */
function projectedNet(twin, snap) {
  let now = 0;
  let later = 0;
  let hours = 0;
  for (const u of UNITS) {
    const { projection } = twin.unitHistory(u);
    now += snap.units[u].bedsOccupied;
    later += projection.length ? projection.at(-1).projectedInUse : snap.units[u].bedsOccupied;
    hours = Math.max(hours, projection.length);
  }
  return { now, later, hours, net: later - now };
}

const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "±0");

function ownKpis(ctx) {
  const { snap, twin } = ctx;
  const t = totals(snap.units);
  const ed = snap.units.ED;
  const boarders = edBoarders(snap);
  const flow = projectedNet(twin, snap);
  const sim = simBadge(snap);
  const freeBy = UNITS.map((u) => `${u} ${freeOf(snap.units[u])}`).join(" · ");
  const closedBy = UNITS.filter((u) => closedOf(snap.units[u])).map((u) => `${u} ${closedOf(snap.units[u])}`).join(" · ");
  return kpiStrip([
    {
      label: "Beds in use",
      value: Math.round(t.fraction * 100),
      unit: "%",
      detail: `${t.occupied} patients in ${t.staffed} usable beds`,
      badge: sim,
      alert: t.fraction > 0.95,
      spark: occupancySeries(twin),
      sparkLabel: "Share of usable beds in use, last 24 hours",
    },
    { label: "Free beds now", value: t.free, detail: freeBy, badge: sim, alert: t.free === 0 },
    {
      label: "Emergency department",
      value: ed.bedsOccupied,
      unit: `in ${ed.bedsStaffed} spaces`,
      detail: snap.edDivertHoursRemaining > 0
        ? `${plural(boarders, "patient")} waiting for a bed upstairs · ambulances diverted`
        : `${plural(boarders, "patient")} waiting for a bed upstairs`,
      badge: sim,
      alert: ed.bedsOccupied > ed.bedsStaffed || boarders >= 5,
    },
    {
      label: "Without a staffed bed",
      value: t.over,
      unit: t.over === 1 ? "patient" : "patients",
      detail: t.closed ? `${t.closed} beds closed for lack of staff (${closedBy})` : "No beds closed for lack of staff",
      badge: sim,
      alert: t.over > 0,
    },
    {
      label: `Next ${flow.hours} h, net`,
      value: signed(flow.net),
      unit: "patients",
      detail: `projected ${flow.later} in use, from planned discharges and recent arrivals`,
      badge: prov("simulated", { label: "Forecast", title: "Projection of the seeded simulation, not a measurement" }),
    },
  ]);
}

function departmentsCard(ctx) {
  const { snap, routes } = ctx;
  const leavingSoon = (unit) =>
    snap.patients.filter((p) => p.unit === unit && p.expectedDischargeTick > snap.tick && p.expectedDischargeTick <= snap.tick + 3).length;
  return html`
    <section class="pane" aria-labelledby="dept-title">
      <header class="pane-head">
        <div>
          <h2 id="dept-title">Units</h2>
          <p>Bar: patients against usable beds; the hatched part is beds closed today (no staff). Select a unit to open it.</p>
        </div>
        ${simBadge(snap)}
      </header>
      <div class="table-wrap">
        <table class="t dept-table">
          <thead><tr>
            <th scope="col">Unit</th><th scope="col" class="dept-barcol">Beds in use</th><th scope="col" class="n">Free</th>
            <th scope="col" class="n hide-s">Waiting in</th><th scope="col" class="n hide-s">Leaving ≤ 3 h</th><th scope="col" class="stcol">Status</th>
          </tr></thead>
          <tbody>
            ${UNITS.map((name) => {
              const u = snap.units[name];
              const st = deptStatus(u);
              return html`<tr data-go="${routes.unit(name)}">
                <td class="dept-name"><a href="#${routes.unit(name)}" data-focus-key="dept-${name}">${UNIT_LABEL[name]}</a><small>${name}</small>
                  ${st.tone !== "ok" ? html`<span class="show-s">${pill(st.word, st.tone)}</span>` : ""}</td>
                <td>${bedsBar(u)}</td>
                <td class="n"><b>${freeOf(u)}</b></td>
                <td class="n hide-s">${u.queue.length || html`<span class="faint">0</span>`}</td>
                <td class="n hide-s">${leavingSoon(name)}</td>
                <td class="stcol">${pill(st.word, st.tone)}</td>
              </tr>`;
            })}
          </tbody>
        </table>
      </div>
      <footer class="pane-foot"><span>Usable beds are the beds with a nurse on shift. A bed without a nurse is not capacity.</span><span>Twin time ${snap.dayTime}, ${snap.timeZoneLabel ?? "German time"}</span></footer>
    </section>
  `;
}

function deptStatus(u) {
  const over = overOf(u);
  if (over) return { word: `${over} in the hallway`, tone: "crit" };
  if (freeOf(u) === 0) return { word: "Full", tone: "warn" };
  if (usedFraction(u) > 0.85) return { word: "Busy", tone: "warn" };
  return { word: "Normal", tone: "ok" };
}

/** Occupancy bar on the physical beds, with closed beds hatched at the right and 85/90% ticks of usable. */
function bedsBar(u) {
  const span = Math.max(u.bedsTotal, u.bedsStaffed, u.bedsOccupied, 1);
  const used = Math.min(u.bedsOccupied, span) / span;
  const closed = closedOf(u) / span;
  const fraction = usedFraction(u);
  const level = fraction > 0.95 ? 5 : fraction > 0.85 ? 4 : 3;
  const tick = (f) => html`<b style="left:${((u.bedsStaffed * f) / span * 100).toFixed(1)}%"></b>`;
  return html`<div class="beds">
    <div class="bar" role="img" aria-label="${u.bedsOccupied} of ${u.bedsStaffed} usable beds in use, ${closedOf(u)} closed">
      <i style="width:${(used * 100).toFixed(1)}%;background:var(--seq-${level})"></i>
      ${closed ? html`<i class="hatch" style="width:${(closed * 100).toFixed(1)}%"></i>` : ""}
      ${tick(0.85)}${tick(0.9)}
    </div>
    <span>${u.bedsOccupied} / ${u.bedsStaffed}</span>
  </div>`;
}

function logTone(e) {
  if (e.level === "block") return "block";
  if (e.level === "decision") return e.text.startsWith("rejected") ? "rejected" : "approved";
  if (e.level === "warn") return "warn";
  return "info";
}

function conversationCard(log, snap) {
  const lines = log.slice(0, LOG_LIMIT);
  return html`
    <section class="pane" aria-labelledby="hosp-log-title">
      <header class="pane-head">
        <div>
          <h2 id="hosp-log-title">Team conversation</h2>
          <p>Newest first. Planners, the Coordinator, the Safety check, the Simulation and you.</p>
        </div>
        ${simBadge(snap)}
      </header>
      <div class="hosp-scroll" data-keep-scroll="log" tabindex="0" role="region" aria-label="Team conversation, newest first">
        ${
          lines.length
            ? html`<ol class="feed hosp-log">
                ${lines.map((e) => {
                  const tone = logTone(e);
                  return html`<li class="hosp-log-${tone}">
                    <time>${e.time}</time>
                    <div>${tone === "block" ? raw(SHIELD) : ""}<span class="actor">${e.actor}</span> ${e.text}</div>
                  </li>`;
                })}
              </ol>`
            : html`<p class="muted">Nobody has said anything yet.</p>`
        }
      </div>
    </section>
  `;
}

function familyCard(messages, snap) {
  return html`
    <section class="pane" aria-labelledby="hosp-family-title">
      <header class="pane-head">
        <div>
          <h2 id="hosp-family-title">What families see</h2>
          <p>Only approved changes, in plain words, without diagnoses.</p>
        </div>
        ${simBadge(snap)}
      </header>
      <div class="pane-body">
        ${
          messages.length
            ? html`<ol class="hosp-bubbles">
                ${messages.map((m) => html`<li><p>${m.text}</p><time>${m.time}</time></li>`)}
              </ol>`
            : html`<p class="muted">Families are only told about approved changes. Nothing approved yet.</p>`
        }
      </div>
    </section>
  `;
}

/** What this hospital reports upward, hourly: exact counts for the authority tier. */
function sharedByMeCard(snap) {
  const own = snap.nearbyCapacity?.[OWN_HOSPITAL.name] ?? null;
  const icu = capabilityStatus(snap.units.ICU);
  return html`
    <section class="pane" aria-labelledby="shared-by-title">
      <header class="pane-head">
        <div>
          <h2 id="shared-by-title">Shared by me</h2>
          <p>To the city and the Regional coordinator, every hour</p>
        </div>
        ${simBadge(snap)}
      </header>
      <div class="pane-body">
        <dl class="kv">
          <dt>Free beds: ED / ICU / Ward</dt><dd class="num">${UNITS.map((u) => freeOf(snap.units[u])).join(" / ")}</dd>
          <dt>Closed for lack of staff</dt><dd class="num">${totals(snap.units).closed}</dd>
          <dt>Emergency department</dt><dd>${snap.edDivertHoursRemaining > 0 ? html`<span class="is-warn-text">Ambulances diverted</span>` : "Open"}</dd>
          <dt>ICU for ambulances</dt><dd class="is-${icu.tone}-text">${icu.word}</dd>
          <dt>Can accept${own ? ` until ${own.validUntil}` : ""}</dt><dd class="num">${own ? `ICU ${own.canAccept.ICU} · Ward ${own.canAccept.Ward}` : "–"}</dd>
        </dl>
        <p class="pane-note">Peers see only the status per capability, not these numbers.</p>
        <div class="never"><b>Never leaves the hospital:</b> patient names, diagnoses, bed-level data, staff names, costs, contracts and pay.</div>
      </div>
    </section>
  `;
}

/** What peers share with us: status per capability; the city figure lives on the Berlin page. */
function sharedWithMeCard(ctx) {
  const { snap, routes } = ctx;
  const peers = snap.hospitals.filter((h) => !h.isOwn);
  const cell = (u) => {
    const s = capabilityStatus(u);
    return html`<td><span class="cap is-${s.tone}" title="${s.reason ? `${s.word} (reason: ${s.reason})` : s.word}">${s.word}${
      s.reason ? html`<small>${s.reason}</small>` : ""
    }</span></td>`;
  };
  return html`
    <section class="pane" aria-labelledby="shared-with-title">
      <header class="pane-head">
        <div>
          <h2 id="shared-with-title">Shared with me</h2>
          <p>Neighbouring hospitals: status per capability</p>
        </div>
        ${simBadge(snap)}
      </header>
      <table class="t peer-table">
        <thead><tr><th scope="col">Hospital</th><th scope="col">ICU</th><th scope="col">Ward</th><th scope="col">ED</th></tr></thead>
        <tbody>
          ${peers.map((h) => {
            const place = HOSPITAL_BY_ID[h.id];
            return html`<tr>
              <td class="peer-name"><a href="#${routes.hospital(h.id)}" data-focus-key="peer-${h.id}">${h.name}</a><small>${place?.district ?? ""} · demo twin</small></td>
              ${cell(h.units.ICU)}${cell(h.units.Ward)}${cell(h.units.ED)}
            </tr>`;
          })}
          <tr class="peer-city">
            <td colspan="4">
              <span class="peer-name"><b>Berlin, all adult ICUs</b></span>
              <span class="peer-city-line">${prov("notshown")} The real DIVI figure is on the <a href="#${routes.berlin}" data-focus-key="peer-berlin">Berlin page</a>; demo twins never change a real total.</span>
            </td>
          </tr>
        </tbody>
      </table>
      <footer class="pane-foot"><span>Exact numbers only inside an offer (see the plan's details). Peer hospitals are fictional.</span></footer>
    </section>
  `;
}

function ownSources(snap) {
  return sourcesFooter([
    { badge: simBadge(snap), text: `All numbers for ${OWN_HOSPITAL.name} and its neighbours come from the seeded simulation (seed ${snap.seed}); the hospitals are fictional demo twins.` },
    { badge: prov("illustrative"), text: "Requests, offers and the sharing payloads show how a real deployment would work; logging and purpose binding are illustrated, not enforced." },
    { badge: prov("notshown"), text: "Per-site ICU status (DIVI-Intensivregister): exists, not shown (licence pending)." },
    { badge: html`<span class="prov is-rule">Rule</span>`, text: "Unit planners, the Coordinator and the Safety check are rule-based; a person approves every plan. No language model is involved." },
  ]);
}

function renderOwn(container, ctx, hosp) {
  const { snap, twin } = ctx;
  const t = totals(snap.units);
  container.innerHTML = String(html`
    <div class="pg">
      ${pageHead({
        level: "Hospital",
        place: `${hosp.district}, Berlin · demo twin`,
        title: hosp.name,
        question: "How full are we, where is it tight, and what needs my decision?",
        sees: "every bed, unit and plan in this hospital; neighbours only as status per capability.",
        status: utilStatus(t.fraction),
        fresh: { badge: simBadge(snap), text: `Twin time ${snap.dayTime}, ${snap.timeZoneLabel ?? "German time"}` },
      })}
      ${ownKpis(ctx)}
      <div class="pg-grid">
        <div class="pg-main">
          ${departmentsCard(ctx)}
          ${bedBoard(ctx)}
          <div class="pg-row2">
            ${conversationCard(twin.log(), snap)}
            ${familyCard(twin.family(), snap)}
          </div>
        </div>
        <aside class="pg-rail" aria-label="Requests and sharing">
          ${requestsCard(ctx)}
          ${sharedByMeCard(snap)}
          ${sharedWithMeCard(ctx)}
        </aside>
      </div>
      ${levelsPanel("hospital", { place: hosp.name })}
      ${ownSources(snap)}
    </div>
  `);

  container.onclick = (event) => {
    if (handleDecisionClick(event, ctx)) return;
    handleBedClick(event, ctx);
  };
  container.onchange = (event) => onDraftEdit(event, ctx);
  container.oninput = (event) => onDraftEdit(event, ctx);
  container.onsubmit = (event) => onRejectSubmit(event, ctx);
}

// =====================================================================================
// Neighbouring hospital: what it reports to the Regional coordinator
// =====================================================================================
function renderNeighbour(container, ctx, hosp) {
  const { snap, twin, routes } = ctx;
  const row = snap.hospitals.find((h) => h.id === hosp.id);
  const t = totals(row.units);
  const worstUnit = UNITS.reduce((a, b) => (usedFraction(row.units[b]) > usedFraction(row.units[a]) ? b : a));
  const history = twin.hospitalHistory(hosp.name);
  const reports = twin.hospitalReports(hosp.name);
  const latest = snap.nearbyCapacity?.[hosp.name] ?? null;
  const showTable = hospState(ctx).showTable;
  const sim = simBadge(snap);
  const before = history.length > 3 ? history.at(-4) : history[0];
  const freeNow = UNITS.reduce((n, u) => n + freeOf(row.units[u]), 0);
  const freeBefore = before ? UNITS.reduce((n, u) => n + before.freeBeds[u], 0) : null;

  container.innerHTML = String(html`
    <div class="pg">
      ${pageHead({
        level: "Hospital",
        place: `${hosp.district}, Berlin · demo twin`,
        title: hosp.name,
        question: `What does ${hosp.short} report to the Regional coordinator, and what can it take?`,
        sees: "the exact free beds this hospital reports each hour (authority view). Its peers see only status per capability.",
        status: utilStatus(t.fraction),
        fresh: { badge: sim, text: `Twin time ${snap.dayTime}, ${snap.timeZoneLabel ?? "German time"}` },
      })}
      ${kpiStrip([
        { label: "Beds in use", value: Math.round(t.fraction * 100), unit: "%", detail: `${t.occupied} patients in ${t.staffed} usable beds`, badge: sim, alert: t.fraction > 0.95 },
        { label: "Free beds now", value: freeNow, detail: UNITS.map((u) => `${u} ${freeOf(row.units[u])}`).join(" · "), badge: sim, alert: freeNow === 0 },
        {
          label: "Busiest unit",
          value: Math.round(usedFraction(row.units[worstUnit]) * 100),
          unit: `% · ${worstUnit}`,
          detail: `${row.units[worstUnit].bedsOccupied} of ${row.units[worstUnit].bedsStaffed} usable beds`,
          badge: sim,
          alert: usedFraction(row.units[worstUnit]) > 0.95,
        },
        {
          label: "Closed: no staff",
          value: t.closed,
          unit: t.closed === 1 ? "bed" : "beds",
          detail: `of ${t.total} beds`,
          badge: sim,
        },
        latest
          ? { label: "Latest offer", value: `${latest.canAccept.ICU} · ${latest.canAccept.Ward}`, unit: "ICU · Ward", detail: `valid until ${latest.validUntil}${freeBefore !== null ? ` · free beds ${signed(freeNow - freeBefore)} in 3 h` : ""}`, badge: sim }
          : { label: "Latest offer", value: "–", detail: "No offer yet", badge: prov("unknown") },
      ])}
      <div class="pg-grid">
        <div class="pg-main">
          <section class="pane" aria-labelledby="dept-title">
            <header class="pane-head">
              <div><h2 id="dept-title">Units</h2><p>Bar: patients against usable beds; the hatched part is beds closed today (no staff).</p></div>
              ${sim}
            </header>
            <div class="table-wrap">
              <table class="t dept-table">
                <thead><tr><th scope="col">Unit</th><th scope="col" class="dept-barcol">Beds in use</th><th scope="col" class="n">Free</th><th scope="col" class="stcol">Status</th></tr></thead>
                <tbody>
                  ${UNITS.map((name) => {
                    const u = row.units[name];
                    const st = deptStatus(u);
                    return html`<tr>
                      <td class="dept-name">${UNIT_LABEL[name]}<small>${name}</small>${st.tone !== "ok" ? html`<span class="show-s">${pill(st.word, st.tone)}</span>` : ""}</td>
                      <td>${bedsBar(u)}</td>
                      <td class="n"><b>${freeOf(u)}</b></td>
                      <td class="stcol">${pill(st.word, st.tone)}</td>
                    </tr>`;
                  })}
                </tbody>
              </table>
            </div>
          </section>
          <section class="pane" aria-labelledby="hosp-chart-title">
            <header class="pane-head">
              <div>
                <h2 id="hosp-chart-title">Free beds since ${history.length ? fullTime(history[0]) : "08:00"}</h2>
                <p>Beds usable today minus patients, as reported each hour.</p>
              </div>
              ${sim}
            </header>
            <div class="pane-body hosp-chart-card">
              ${chartLegend(history)}
              <div class="hosp-chart" data-hosp-chart>${freeBedsChart(history, chartWidth(container))}</div>
              ${
                history.length
                  ? html`<button type="button" class="btn btn-ghost hosp-table-toggle" data-action="toggle-table" data-focus-key="toggle-table" aria-expanded="${showTable}" aria-controls="hosp-history-table">
                      ${showTable ? "Hide the numbers" : "Show the numbers"}
                    </button>`
                  : ""
              }
              ${showTable ? historyTable(history) : ""}
            </div>
          </section>
        </div>
        <aside class="pg-rail" aria-label="Reports and sharing">
          <section class="pane pane-req" aria-labelledby="hosp-reports-title">
            <header class="pane-head">
              <div><h2 id="hosp-reports-title">Latest offers</h2><p>What ${hosp.short} told the Regional coordinator it can take</p></div>
              ${sim}
            </header>
            ${
              reports.length
                ? html`<ul class="req-list">
                    ${reports.map(
                      (r) => html`<li class="req">
                        <div class="req-top"><span class="req-from num">${r.hourRange}</span>${confBar(r.confidence)}</div>
                        <div class="req-what">Can take ICU ${r.canAccept.ICU} · Ward ${r.canAccept.Ward}</div>
                        ${r.note ? html`<p class="req-why">${r.note}</p>` : ""}
                      </li>`,
                    )}
                  </ul>`
                : html`<div class="pane-body"><p class="muted">No offers yet. The first one comes with the next plan.</p></div>`
            }
            ${
              latest
                ? html`<div class="pane-body pane-body-tight"><dl class="kv">
                    <dt>Offer valid until</dt><dd class="num">${latest.validUntil}</dd>
                    <dt>Prefers</dt><dd>${latest.conditionsPreferred.join(", ") || "any condition"}</dd>
                  </dl></div>`
                : ""
            }
          </section>
          <section class="pane" aria-labelledby="peer-view-title">
            <header class="pane-head">
              <div><h2 id="peer-view-title">What its peers see</h2><p>Status per capability, no exact numbers</p></div>
              ${sim}
            </header>
            <div class="pane-body">
              <dl class="kv">
                ${UNITS.map((u) => {
                  const s = capabilityStatus(row.units[u]);
                  return html`<dt>${UNIT_LABEL[u]}</dt><dd><span class="cap is-${s.tone}">${s.word}${s.reason ? html`<small>${s.reason}</small>` : ""}</span></dd>`;
                })}
              </dl>
              <div class="never"><b>Never shared with peers:</b> patient data, staff data, costs and contracts.</div>
            </div>
            <footer class="pane-foot">
              <a href="#${routes.berlin}" data-focus-key="back-berlin">‹ Back to Berlin</a>
              <a href="#${routes.hospital(OWN_HOSPITAL.id)}" data-focus-key="open-own">Open ${OWN_HOSPITAL.name}</a>
            </footer>
          </section>
        </aside>
      </div>
      ${levelsPanel("hospital", { place: hosp.name })}
      ${sourcesFooter([
        { badge: sim, text: `All numbers for ${hosp.name} come from the seeded simulation (seed ${snap.seed}); the hospital is a fictional demo twin.` },
        { badge: prov("illustrative"), text: "Offers to the Regional coordinator show how a real request and offer flow would work." },
        { badge: prov("notshown"), text: "Per-site ICU status (DIVI-Intensivregister): exists, not shown (licence pending)." },
      ])}
    </div>
  `);

  container.onclick = (event) => {
    if (!event.target.closest("[data-action='toggle-table']")) return;
    const st = hospState(ctx);
    st.showTable = !st.showTable;
    ctx.rerender();
  };
}

// -- free-beds chart -------------------------------------------------------------------------

/** Draw at the chart's real pixel width so labels stay 11px on a phone and on a wide screen. */
function chartWidth(container) {
  const existing = container.querySelector?.("[data-hosp-chart]");
  if (existing?.clientWidth) return clampWidth(existing.clientWidth);
  const page = container.clientWidth;
  if (!page) return 640;
  const inner = page - (page > 720 ? 48 : 32); // .page padding
  return clampWidth(page > 1180 ? inner - 360 - 20 - 34 : inner - 34); // minus the rail and card padding
}

const clampWidth = (w) => Math.max(300, Math.min(960, Math.round(w)));

// History rows carry "Thursday 09:00" as dayTime (older rows only have "09:00").
const fullTime = (h) => h.dayTime ?? h.time;
const dayOf = (h) => (h.dayTime ? h.dayTime.split(" ")[0] : "");
/** True once the history runs past midnight, so a bare "09:00" would be ambiguous. */
const spansDays = (history) => history.length > 1 && dayOf(history[0]) !== dayOf(history.at(-1));
/** "Thu 09:00" for the x axis when the history spans days, else "09:00". */
const shortTime = (h, withDay) => (withDay && h.dayTime ? `${dayOf(h).slice(0, 3)} ${h.time}` : h.time);

/** Round axis ticks: 0, step, 2*step ... covering [lo, hi]. */
function niceTicks(lo, hi, target = 4) {
  const span = Math.max(1, hi - lo);
  const raw10 = 10 ** Math.floor(Math.log10(span / target));
  const step = [1, 2, 5, 10].map((m) => m * raw10).find((s) => span / s <= target) ?? 10 * raw10;
  const niceStep = Math.max(1, step);
  const start = Math.floor(lo / niceStep) * niceStep;
  const end = Math.ceil(hi / niceStep) * niceStep;
  const ticks = [];
  for (let v = start; v <= end; v += niceStep) ticks.push(v);
  return ticks;
}

function chartLegend(history) {
  const last = history.at(-1);
  return html`
    <div class="legend hosp-chart-legend">
      ${UNITS.map((u) => html`<span><i class="hosp-key hosp-s-${u}"></i>${u}${last ? html` <b class="num">${last.freeBeds[u]}</b>` : ""}</span>`)}
    </div>
  `;
}

function freeBedsChart(history, width) {
  const n = history.length;
  if (n < 2) return html`<p class="muted">The chart starts after the second hourly report.</p>`;
  const W = width;
  const H = 220;
  const m = { l: 34, r: 24, t: 14, b: 30 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const values = history.flatMap((h) => UNITS.map((u) => h.freeBeds[u]));
  const ticks = niceTicks(Math.min(0, ...values), Math.max(1, ...values));
  const lo = ticks[0];
  const hi = ticks.at(-1);
  const x = (i) => m.l + (i / (n - 1)) * pw;
  const y = (v) => m.t + ph - ((v - lo) / (hi - lo)) * ph;
  const f = (v) => v.toFixed(1);

  // Label every k-th hour, counted back from the latest so "now" is always labelled.
  const withDay = spansDays(history);
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(pw / (withDay ? 84 : 64)))));
  const xLabels = history.map((h, i) => ((n - 1 - i) % every === 0 ? { i, time: shortTime(h, withDay) } : null)).filter(Boolean);

  const colW = pw / (n - 1);
  const columns = history.map((h, i) => {
    const tip = `${withDay ? fullTime(h) : h.time}: ${UNITS.map((u) => `${u} ${h.freeBeds[u]}`).join(", ")} free`;
    const x0 = Math.max(m.l, x(i) - colW / 2);
    const x1 = Math.min(W - m.r, x(i) + colW / 2);
    return html`<g class="hosp-col"><title>${tip}</title>
      <rect x="${f(x0)}" y="${m.t}" width="${f(Math.max(1, x1 - x0))}" height="${ph}" fill="transparent"></rect>
      <line x1="${f(x(i))}" x2="${f(x(i))}" y1="${m.t}" y2="${m.t + ph}" fill="none"></line></g>`;
  });

  const summary = `Free beds per unit from ${fullTime(history[0])} to ${fullTime(history.at(-1))}. Now: ${UNITS.map(
    (u) => `${u} ${history.at(-1).freeBeds[u]}`,
  ).join(", ")}.`;

  return html`
    <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${summary}" preserveAspectRatio="xMinYMin meet">
      <g class="hosp-grid">
        ${ticks.map(
          (t) => html`<line x1="${m.l}" x2="${W - m.r}" y1="${f(y(t))}" y2="${f(y(t))}" fill="none"${t === 0 ? raw(' class="is-zero"') : ""}></line>
            <text x="${m.l - 6}" y="${f(y(t) + 4)}" text-anchor="end">${t}</text>`,
        )}
      </g>
      <g class="hosp-xaxis">
        ${xLabels.map((l) => html`<text x="${f(x(l.i))}" y="${H - 10}" text-anchor="middle">${l.time}</text>`)}
      </g>
      <g class="hosp-cols">${columns}</g>
      ${UNITS.map((u) => {
        const pts = history.map((h, i) => `${f(x(i))},${f(y(h.freeBeds[u]))}`).join(" ");
        const last = history.at(-1).freeBeds[u];
        return html`<g class="hosp-series hosp-s-${u}">
          <polyline points="${pts}" fill="none"></polyline>
          <circle cx="${f(x(n - 1))}" cy="${f(y(last))}" r="4"></circle>
        </g>`;
      })}
    </svg>
  `;
}

function historyTable(history) {
  const withDay = spansDays(history);
  return html`
    <div class="table-wrap hosp-history-table" id="hosp-history-table" data-keep-scroll="hosp-history" role="region" aria-label="Free beds per hour, newest first" tabindex="0">
      <table class="table">
        <thead><tr><th>Time</th>${UNITS.map((u) => html`<th class="num">${u} free</th>`)}</tr></thead>
        <tbody>
          ${[...history].reverse().map(
            (h) => html`<tr><td class="num">${withDay ? fullTime(h) : h.time}</td>${UNITS.map((u) => html`<td class="num">${h.freeBeds[u]}</td>`)}</tr>`,
          )}
        </tbody>
      </table>
    </div>
  `;
}
