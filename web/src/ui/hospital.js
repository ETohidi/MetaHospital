// Level 4: one hospital. Our own hospital gets the full dashboard (bed board, the plan
// for the next hour, the team conversation and what families see); a neighbouring
// hospital shows the free beds it reports to the Regional coordinator.

import { HOSPITAL_BY_ID, OWN_HOSPITAL, UNITS, UNIT_LABEL } from "../data/places.js";
import { actionLabel } from "../engine/labels.js";
import { ACUITY_LABEL, acuity, chip, confBar, html, meter, pct, plural, raw, UTIL_LABEL, utilTone } from "./dom.js";

const OTHER_REASON = "Other (type a reason)";
const REJECT_REASONS = [
  "Not enough staff for this",
  "Patient too unstable to move",
  "Keep beds free for the emergency",
  "Wrong priority order",
  "A nearby hospital should take this patient",
  OTHER_REASON,
];


const STATUS_TONE = { approved: "ok", rejected: "crit", expired: "" };
const STATUS_LABEL = { approved: "Approved", rejected: "Rejected", expired: "Expired", pending: "Waiting" };

const LOG_LIMIT = 80;
const ARRIVAL_MS = 1600; // matches the hosp-arrive animation in hospital.css

const SHIELD =
  '<svg class="hosp-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.2l5.6 2v4.3c0 3.4-2.3 6.1-5.6 7.3-3.3-1.2-5.6-3.9-5.6-7.3V3.2z" fill="currentColor"/><path d="M6 6l4 4M10 6l-4 4" fill="none" stroke="var(--surface)" stroke-width="1.6" stroke-linecap="round"/></svg>';

// -- entry point ----------------------------------------------------------------
export function render(container, ctx) {
  const hosp = HOSPITAL_BY_ID[ctx.route.hospitalId];
  ctx.ui.hospital ??= { selected: null, arrivals: null, showTable: false };
  ctx.ui.drafts ??= {};
  if (!hosp) {
    container.innerHTML = String(html`<div class="card"><p>This hospital is not part of the network.</p>
      <p><a href="#${ctx.routes.berlin}" data-focus-key="back-berlin">Back to Berlin</a></p></div>`);
    return;
  }
  if (hosp.isOwn) renderOwn(container, ctx, hosp);
  else renderNeighbour(container, ctx, hosp);
}

// -- shared helpers -----------------------------------------------------------------
const usedFraction = (u) => (u.bedsStaffed ? u.bedsOccupied / u.bedsStaffed : 1);

function sumUnits(units) {
  let occupied = 0;
  let staffed = 0;
  for (const u of UNITS) {
    occupied += units[u].bedsOccupied;
    staffed += units[u].bedsStaffed;
  }
  return staffed ? occupied / staffed : 1;
}

// =====================================================================================
// Own hospital
// =====================================================================================
function renderOwn(container, ctx, hosp) {
  const { snap, twin } = ctx;
  const arrivals = arrivalState(ctx);
  const selected = snap.patients.find((p) => p.id === ctx.ui.hospital.selected) ?? null;
  if (!selected) ctx.ui.hospital.selected = null;

  container.innerHTML = String(html`
    ${ownHead(snap, hosp)}
    <div class="layout">
      <section class="stage stack" aria-labelledby="hosp-board-title">
        <div class="hosp-board-head">
          <h2 id="hosp-board-title">Bed board</h2>
          <p class="muted">One square per bed. Point at or tap a patient's bed to see who is in it.</p>
        </div>
        ${bedLegend(snap)}
        ${UNITS.map((unit) => unitBlock(unit, ctx, arrivals, selected))}
      </section>
      <aside class="panel" aria-label="Plan and conversation">
        ${snap.pendingBundle ? planCard(ctx, snap.pendingBundle) : noPlanCard(twin)}
        ${conversationCard(twin.log())}
        ${familyCard(twin.family())}
      </aside>
    </div>
  `);

  container.onclick = (event) => onOwnClick(event, ctx);
  container.onchange = (event) => onDraftEdit(event, ctx);
  container.oninput = (event) => onDraftEdit(event, ctx);
  container.onsubmit = (event) => onRejectSubmit(event, ctx);
}

function ownHead(snap, hosp) {
  const util = sumUnits(snap.units);
  const tone = utilTone(util);
  return html`
    <div class="view-head">
      <div>
        <div class="eyebrow">Hospital · ${hosp.district}</div>
        <h1>${hosp.name}</h1>
        <p>The bed board, the plan for the next hour and what everyone said about it.</p>
      </div>
      <div class="row hosp-chips">
        ${chip(`${UTIL_LABEL[tone]} · ${pct(util)} of usable beds in use`, tone)}
        ${snap.surge ? chip(`Emergency: ${snap.surge} · ${snap.surgeTicksRemaining}h left`, "crit") : ""}
        ${
          snap.edDivertHoursRemaining > 0
            ? chip(`Ambulances diverted · ${snap.edDivertHoursRemaining}h left`, "warn", {
                title: "Approved plan: the ED takes about half its usual ambulance arrivals.",
              })
            : ""
        }
      </div>
    </div>
  `;
}

// -- bed board ----------------------------------------------------------------------

/** Patients who just moved in with the last approval get a one-shot highlight. */
function arrivalState(ctx) {
  const transfers = ctx.snap.recentTransfers;
  const st = ctx.ui.hospital;
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

function bedLegend(snap) {
  const overflow = UNITS.some((u) => snap.units[u].bedsStaffed > snap.units[u].bedsTotal);
  return html`
    <div class="legend hosp-legend">
      ${[1, 2, 3, 4, 5].map(
        (a) => html`<span><i class="swatch hosp-a${a}"></i>${a} ${ACUITY_LABEL[a]}</span>`,
      )}
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
  const cls = [
    "hosp-bed",
    "is-filled",
    `hosp-a${p.acuity}`,
    hallway && "is-hallway",
    p.surge && "is-surge",
    arrival && "is-arrival",
    selected && "is-selected",
  ]
    .filter(Boolean)
    .join(" ");
  const where = hallway ? "Hallway" : `Bed ${p.bed}`;
  const extra = [p.surge && "emergency arrival", arrival && "just moved in"].filter(Boolean).join(", ");
  const label = `${where}: ${patientLabel(p)}${extra ? ` (${extra})` : ""}`;
  const style = arrival && delay ? raw(` style="animation-delay:-${Math.round(delay)}ms"`) : "";
  return html`<button type="button" class="${cls}" title="${label}" aria-label="${label}" aria-pressed="${selected ? "true" : "false"}"
    data-patient="${p.id}" data-focus-key="bed-${p.id}"${style}></button>`;
}

function unitBlock(unit, ctx, arrivals, selected) {
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
  const fraction = usedFraction(u);
  const tone = utilTone(fraction);
  const queue = u.queue.length;
  const unitHref = `#${routes.unit(unit)}`;
  const showDetail = selected && selected.unit === unit;

  return html`
    <article class="card hosp-unit is-${tone}" aria-labelledby="hosp-unit-${unit}">
      <header class="hosp-unit-head">
        <div>
          <h3 id="hosp-unit-${unit}"><a href="${unitHref}" data-focus-key="unit-${unit}">${unit}</a> <span class="hosp-unit-long">${UNIT_LABEL[unit]}</span></h3>
          <p class="hosp-unit-counts"><b>${u.bedsOccupied}</b> in use · ${u.bedsStaffed} usable today · ${u.bedsTotal} beds</p>
        </div>
        <a class="btn btn-ghost hosp-unit-open" href="${unitHref}" aria-label="Open ${unit}: ${UNIT_LABEL[unit]} view" data-focus-key="open-${unit}">Open ${unit} ›</a>
      </header>
      ${meter(fraction, { label: `${unit}: ${pct(fraction)} of usable beds in use` })}
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
  const waiting = UNITS.map((u) => ({ unit: u, item: snap.units[u].queue.find((q) => q.patientId === p.id) })).find(
    (x) => x.item,
  );
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

// -- plan card ------------------------------------------------------------------------
function draftFor(ctx, bundleId) {
  return ctx.ui.drafts[bundleId] ?? { choice: REJECT_REASONS[0], custom: "" };
}

function reasonOf(draft) {
  return draft.choice === OTHER_REASON ? draft.custom.trim() : draft.choice;
}

/** Plan rows grouped by author, in the order the authors first appear. */
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
    : html`<span class="hosp-pa-who mono">${r.patientId}</span> ${acuity(r.acuity)} <span class="hosp-pa-cond">${r.condition}</span>`;
  return html`<li class="hosp-pa${unitLevel ? " is-unit" : ""}">
    <div class="hosp-pa-top">${who} <span class="hosp-pa-sep" aria-hidden="true">·</span> <span class="hosp-pa-move">${r.movement}</span></div>
    <div class="hosp-pa-why"><span class="hosp-pa-reason">${r.reason}</span> ${confBar(r.confidence)} <span class="hosp-pa-by">by ${r.author}</span></div>
  </li>`;
}

function planList(rows) {
  if (!rows.length) return html`<p class="muted">No actions proposed this hour.</p>`;
  return html`
    <div class="hosp-plan-list" role="group" aria-label="Proposed actions">
      ${groupByAuthor(rows).map(
        (g) => html`<div class="hosp-pa-group">
          <h4 class="hosp-pa-head">${g.author} <span class="hosp-pa-count">· ${plural(g.items.length, "action")}</span></h4>
          <ol class="hosp-pa-list">${g.items.map(planItem)}</ol>
        </div>`,
      )}
    </div>
  `;
}

function beforeAfter(b) {
  return html`
    <div class="hosp-delta-wrap">
      <p class="faint hosp-caption">Patients per unit now → if you approve</p>
      <dl class="hosp-delta">
        ${UNITS.map((u) => {
          const d = b.after[u] - b.before[u];
          const sign = d > 0 ? `+${d}` : d < 0 ? `−${-d}` : "±0";
          return html`<div><dt>${u}</dt><dd><span class="mono">${b.before[u]} → ${b.after[u]}</span> <span class="faint mono">${sign}</span></dd></div>`;
        })}
      </dl>
    </div>
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

function nearbyList(allCapacity) {
  // Our own hospital answers the Regional coordinator too, but it isn't "nearby".
  const capacity = allCapacity.filter((c) => c.hospital !== OWN_HOSPITAL.name);
  if (!capacity.length) return "";
  return html`
    <div class="hosp-nearby">
      <h4>Nearby capacity</h4>
      <ul>
        ${capacity.map(
          (c) => html`<li>
            <span><b>${c.hospital}</b>: accepts ICU ${c.canAccept.ICU} / Ward ${c.canAccept.Ward} until ${c.validUntil}</span>
            ${confBar(c.confidence)}
          </li>`,
        )}
      </ul>
    </div>
  `;
}

function planCard(ctx, b) {
  const draft = draftFor(ctx, b.id);
  const reason = reasonOf(draft);
  const other = draft.choice === OTHER_REASON;
  const conf = b.overallConfidence;
  return html`
    <section class="card hosp-plan" aria-labelledby="hosp-plan-title">
      <div class="eyebrow">Plan for the next hour</div>
      <h3 id="hosp-plan-title">Plan for ${b.hourRange}</h3>
      ${beforeAfter(b)}
      ${planList(b.rows)}
      ${
        conf === null || conf === undefined
          ? ""
          : html`<div class="row hosp-conf">
              <span>Overall confidence</span> ${confBar(conf)}
              ${conf < 0.5 ? chip("Review carefully", "warn", { title: "The least certain action is below 0.50" }) : ""}
            </div>`
      }
      <p class="hosp-summary"><span class="actor">Coordinator:</span> ${b.summary}</p>
      ${blockedList(b.safety)}
      ${nearbyList(b.nearbyCapacity)}
      <div class="hosp-decide">
        <button type="button" class="btn btn-ok" data-action="approve" data-bundle="${b.id}" data-focus-key="approve-${b.id}">Approve plan</button>
        <form class="hosp-reject" data-reject="${b.id}">
          <label class="hosp-label" for="reject-reason-${b.id}">Reason for rejecting</label>
          <select class="select" id="reject-reason-${b.id}" data-draft="choice" data-bundle="${b.id}" data-focus-key="reason-${b.id}">
            ${REJECT_REASONS.map((r) => html`<option value="${r}"${r === draft.choice ? raw(" selected") : ""}>${r}</option>`)}
          </select>
          <input class="input" id="reject-custom-${b.id}" data-draft="custom" data-bundle="${b.id}" data-focus-key="custom-${b.id}" type="text"
            maxlength="200" autocomplete="off" placeholder="Type a reason" aria-label="Your reason"
            value="${draft.custom}"${other ? "" : raw(" hidden")} />
          <button type="submit" class="btn btn-danger" data-focus-key="reject-${b.id}"${reason ? "" : raw(" disabled")}>Reject plan</button>
        </form>
        <p class="faint hosp-caption">Your reason goes back to the unit planners and shapes their next plan.</p>
      </div>
    </section>
  `;
}

function noPlanCard(twin) {
  const decided = twin.bundles().filter((b) => b.status !== "pending").slice(0, 3);
  return html`
    <section class="card hosp-plan" aria-labelledby="hosp-plan-title">
      <div class="eyebrow">Plan for the next hour</div>
      <h3 id="hosp-plan-title">No plan is waiting</h3>
      <p class="muted">No plan is waiting. Press Next hour and the unit planners will propose one.</p>
      ${
        decided.length
          ? html`<h4 class="hosp-subhead">Recent plans</h4>
            <ul class="hosp-history">
              ${decided.map(
                (b) => html`<li>
                  <span class="mono">${b.hourRange}</span>
                  ${chip(STATUS_LABEL[b.status] ?? b.status, STATUS_TONE[b.status] ?? "")}
                  <span class="faint">${b.decidedTime ? `at ${b.decidedTime}` : ""}</span>
                  ${b.status === "rejected" && b.reason ? html`<span class="hosp-history-reason">“${b.reason}”</span>` : ""}
                </li>`,
              )}
            </ul>`
          : ""
      }
    </section>
  `;
}

// -- conversation and families -----------------------------------------------------------
function logTone(e) {
  if (e.level === "block") return "block";
  if (e.level === "decision") return e.text.startsWith("rejected") ? "rejected" : "approved";
  if (e.level === "warn") return "warn";
  return "info";
}

function conversationCard(log) {
  const lines = log.slice(0, LOG_LIMIT);
  return html`
    <section class="card" aria-labelledby="hosp-log-title">
      <h3 id="hosp-log-title">Team conversation</h3>
      <p class="faint hosp-caption">Newest first. Planners, the Coordinator, the Safety check, the Simulation and you.</p>
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

function familyCard(messages) {
  return html`
    <section class="card" aria-labelledby="hosp-family-title">
      <h3 id="hosp-family-title">What families see</h3>
      ${
        messages.length
          ? html`<ol class="hosp-bubbles">
              ${messages.map((m) => html`<li><p>${m.text}</p><time>${m.time}</time></li>`)}
            </ol>`
          : html`<p class="muted">Families are only told about approved changes. Nothing approved yet.</p>`
      }
    </section>
  `;
}

// -- handlers --------------------------------------------------------------------------------
function onOwnClick(event, ctx) {
  const target = event.target;
  const approve = target.closest("[data-action='approve']");
  if (approve) {
    approvePlan(ctx, Number(approve.dataset.bundle));
    return;
  }
  if (target.closest("[data-action='bed-close']")) {
    ctx.ui.hospital.selected = null;
    ctx.rerender();
    return;
  }
  const cell = target.closest("[data-patient]");
  if (cell) {
    const id = cell.dataset.patient;
    ctx.ui.hospital.selected = ctx.ui.hospital.selected === id ? null : id;
    ctx.rerender();
  }
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
function onDraftEdit(event, ctx) {
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

function onRejectSubmit(event, ctx) {
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
// Neighbouring hospital
// =====================================================================================
function renderNeighbour(container, ctx, hosp) {
  const { snap, twin, routes } = ctx;
  const row = snap.hospitals.find((h) => h.id === hosp.id);
  const worstUnit = ["ICU", "Ward"].reduce((a, b) => (usedFraction(row.units[b]) > usedFraction(row.units[a]) ? b : a));
  const worst = usedFraction(row.units[worstUnit]);
  const tone = utilTone(worst);
  const history = twin.hospitalHistory(hosp.name);
  const reports = twin.hospitalReports(hosp.name);
  const latest = snap.nearbyCapacity?.[hosp.name] ?? null;
  const showTable = ctx.ui.hospital.showTable;

  container.innerHTML = String(html`
    <div class="view-head">
      <div>
        <div class="eyebrow">Neighbouring hospital · ${hosp.district}</div>
        <h1>${hosp.name}</h1>
        <p>Reports its free beds to the Regional coordinator every hour. Patient-level detail is only simulated for ${OWN_HOSPITAL.name} in this MVP.</p>
      </div>
      <div class="row hosp-chips">
        ${chip(`${UTIL_LABEL[tone]} · ${worstUnit} ${pct(worst)} in use`, tone, {
          title: "The busier of its ICU and Ward, as a share of beds usable today",
        })}
      </div>
    </div>
    <div class="layout">
      <section class="stage stack" aria-label="Free beds">
        <div class="grid-3">${UNITS.map((u) => neighbourTile(u, row.units[u]))}</div>
        <section class="card hosp-chart-card" aria-labelledby="hosp-chart-title">
          <div class="hosp-chart-head">
            <div>
              <h3 id="hosp-chart-title">Free beds since ${history.length ? fullTime(history[0]) : "08:00"}</h3>
              <p class="faint hosp-caption">Beds usable today minus patients, as reported each hour.</p>
            </div>
            ${chartLegend(history)}
          </div>
          <div class="hosp-chart" data-hosp-chart>${freeBedsChart(history, chartWidth(container))}</div>
          ${
            history.length
              ? html`<button type="button" class="btn btn-ghost hosp-table-toggle" data-action="toggle-table" data-focus-key="toggle-table" aria-expanded="${showTable}" aria-controls="hosp-history-table">
                  ${showTable ? "Hide the numbers" : "Show the numbers"}
                </button>`
              : ""
          }
          ${showTable ? historyTable(history) : ""}
        </section>
      </section>
      <aside class="panel" aria-label="Reports">
        <section class="card" aria-labelledby="hosp-reports-title">
          <h3 id="hosp-reports-title">Latest reports</h3>
          <p class="faint hosp-caption">What ${hosp.short} told the Regional coordinator it can take.</p>
          ${
            reports.length
              ? html`<ol class="hosp-reports">
                  ${reports.map(
                    (r) => html`<li>
                      <div class="hosp-report-top"><span class="mono">${r.hourRange}</span> ${confBar(r.confidence)}</div>
                      <div>Accepts <b>ICU ${r.canAccept.ICU}</b> / <b>Ward ${r.canAccept.Ward}</b></div>
                      ${r.note ? html`<div class="muted">${r.note}</div>` : ""}
                    </li>`,
                  )}
                </ol>`
              : html`<p class="muted">No reports yet. The first one comes with the next plan.</p>`
          }
          ${
            latest
              ? html`<dl class="kv hosp-latest">
                  <dt>Offer valid until</dt><dd class="mono">${latest.validUntil}</dd>
                  <dt>Prefers</dt><dd>${latest.conditionsPreferred.join(", ") || "any condition"}</dd>
                </dl>`
              : ""
          }
        </section>
        <div class="row">
          <a class="btn" href="#${routes.berlin}" data-focus-key="back-berlin">‹ Back to Berlin</a>
          <a class="btn btn-ghost" href="#${routes.hospital(OWN_HOSPITAL.id)}" data-focus-key="open-own">Open ${OWN_HOSPITAL.name}</a>
        </div>
      </aside>
    </div>
  `);

  container.onclick = (event) => {
    if (!event.target.closest("[data-action='toggle-table']")) return;
    ctx.ui.hospital.showTable = !ctx.ui.hospital.showTable;
    ctx.rerender();
  };
}

function neighbourTile(unit, u) {
  const free = Math.max(0, u.bedsStaffed - u.bedsOccupied);
  const fraction = usedFraction(u);
  return html`
    <div class="card hosp-tile">
      <div class="eyebrow">${UNIT_LABEL[unit]}</div>
      <div class="stat">
        <span class="stat-value">${free}</span>
        <span class="stat-label">${unit} ${free === 1 ? "bed" : "beds"} free</span>
      </div>
      <p class="hosp-tile-counts">${u.bedsOccupied} in use · ${u.bedsStaffed} usable today</p>
      ${meter(fraction, { label: `${unit}: ${pct(fraction)} of usable beds in use` })}
    </div>
  `;
}

// -- free-beds chart -------------------------------------------------------------------------

/** Draw at the chart's real pixel width so labels stay 11px on a phone and on a wide screen. */
function chartWidth(container) {
  const existing = container.querySelector?.("[data-hosp-chart]");
  if (existing?.clientWidth) return clampWidth(existing.clientWidth);
  const page = container.clientWidth;
  if (!page) return 640;
  const inner = page - 40; // .page padding
  return clampWidth(inner > 940 ? inner - 380 - 16 - 34 : inner - 34); // minus the panel and card padding
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
      ${UNITS.map(
        (u) => html`<span><i class="hosp-key hosp-s-${u}"></i>${u}${last ? html` <b class="num">${last.freeBeds[u]}</b>` : ""}</span>`,
      )}
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
            (h) => html`<tr><td class="mono">${withDay ? fullTime(h) : h.time}</td>${UNITS.map((u) => html`<td class="num">${h.freeBeds[u]}</td>`)}</tr>`,
          )}
        </tbody>
      </table>
    </div>
  `;
}
