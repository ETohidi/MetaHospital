// The Coordinator: bundles the unit planners' proposals into one plan per hour, resolves
// conflicts, runs the safety check, and adds the Regional coordinator's diverts to
// neighbour hospitals for ICU patients who can't be taken locally.

import { clock, hourRange as formatHourRange } from "./clock.js";
import * as safety from "./safety.js";
import { OWN_HOSPITAL_NAME } from "./state.js";
import { actionLabel } from "./labels.js";
import { ICU_ADMIT_MIN_ACUITY, WARD_ADMIT_MIN_ACUITY } from "./sim.js";

const MOVEMENT_BY_ACTION = { defer_transfer: "waits", divert_ed: "diverted" };
export const DIVERT_MIN_ACUITY = 4; // only suggest divert_to for patients this sick or sicker
export const REGIONAL_AUTHOR = "Regional coordinator";
// Only the newest plan can be pending, so older ones can go; a week of hourly plans stays.
export const BUNDLE_LIMIT = 24 * 7;

/** "1 bed", "3 beds" */
export const bedCount = (n) => `${n} ${n === 1 ? "bed" : "beds"}`;

/** Same patient claimed by two accept_transfer actions -> the unit that fits their acuity wins. */
export function resolveConflicts(state, proposals) {
  const result = structuredClone(proposals);
  const claims = new Map(); // patientId -> [[proposalIndex, actionIndex, unit]]
  result.forEach((p, i) =>
    p.actions.forEach((a, j) => {
      if (a.type !== "accept_transfer" || !a.patientId) return;
      if (!claims.has(a.patientId)) claims.set(a.patientId, []);
      claims.get(a.patientId).push([i, j, p.unit]);
    }),
  );

  const drop = new Set();
  for (const [patientId, list] of claims) {
    if (list.length <= 1) continue;
    const acuity = state.patients.get(patientId)?.acuity ?? 0;
    const idealUnit = acuity >= ICU_ADMIT_MIN_ACUITY ? "ICU" : acuity >= WARD_ADMIT_MIN_ACUITY ? "Ward" : "ED";
    const winner = list.find((c) => c[2] === idealUnit) ?? list[0];
    for (const c of list) {
      if (c === winner) continue;
      drop.add(`${c[0]}:${c[1]}`);
      state.addLog(
        "Coordinator",
        "info",
        `conflict: patient ${patientId} claimed by multiple units; kept ${winner[2]}, dropped ${c[2]}`,
      );
    }
  }
  result.forEach((p, i) => {
    p.actions = p.actions.filter((_, j) => !drop.has(`${i}:${j}`));
  });
  return result;
}

function movement(unit, a) {
  if (a.type in MOVEMENT_BY_ACTION) return MOVEMENT_BY_ACTION[a.type];
  switch (a.type) {
    case "accept_transfer":
      return `${a.from || "?"} → ${unit}`;
    case "expedite_discharge":
      return `${unit} → discharged`;
    case "open_overflow":
      return `+${a.beds ?? 0} overflow ${a.beds === 1 ? "bed" : "beds"}`;
    case "request_beds":
      return `requested ${bedCount(a.beds ?? 0)} (${a.urgency || "n/a"})`;
    case "defer_elective":
      return "elective deferred";
    case "divert_to":
      return `→ ${a.hospital || "?"}`;
    default:
      return a.type;
  }
}

function planRow(state, p, a) {
  const patient = a.patientId ? state.patients.get(a.patientId) : undefined;
  return {
    unit: p.unit,
    author: p.author,
    patientId: a.patientId || "—",
    condition: patient ? patient.condition : "—",
    acuity: patient ? patient.acuity : null,
    movement: movement(p.unit, a),
    actionType: a.type,
    confidence: a.confidence ?? p.confidence,
    reason: a.reason || p.rationale,
  };
}

/**
 * Neighbour (never our own hospital) with ICU room left for this patient: one that
 * prefers the patient's condition if possible, then the highest confidence.
 */
function bestNeighbourFor(capacity, remaining, condition) {
  const candidates = Object.keys(capacity).filter(
    (name) => name !== OWN_HOSPITAL_NAME && (remaining[name]?.ICU ?? 0) > 0,
  );
  if (!candidates.length) return null;
  const preferring = candidates.filter((name) => capacity[name].conditionsPreferred?.includes(condition));
  const pool = preferring.length ? preferring : candidates;
  return pool.reduce((best, name) => (capacity[name].confidence > capacity[best].confidence ? name : best));
}

/**
 * Diverts for acuity >= 4 ICU-queue patients the local ICU can't take this hour: after
 * the allowed unit proposals, ICU has `staffed - after` beds free; the sickest,
 * longest-waiting patients get those, the rest are offered to neighbours with room.
 */
export function suggestDiverts(state, allowedProposals, capacity, { after, staffed }) {
  const covered = new Set(
    allowedProposals
      .filter((p) => p.unit === "ICU")
      .flatMap((p) => p.actions)
      .filter((a) => a.type === "accept_transfer")
      .map((a) => a.patientId),
  );
  const waiting = state.units.ICU.queue
    .filter((q) => q.acuity >= DIVERT_MIN_ACUITY && !covered.has(q.patientId) && state.patients.has(q.patientId))
    .sort((a, b) => b.acuity - a.acuity || b.waitingTicks - a.waitingTicks);
  const free = Math.max(0, staffed.ICU - after.ICU);
  const needDivert = waiting.slice(free);
  if (!needDivert.length) return null;

  const remaining = Object.fromEntries(Object.entries(capacity).map(([name, cap]) => [name, { ...cap.canAccept }]));
  const actions = [];
  for (const q of needDivert) {
    const name = bestNeighbourFor(capacity, remaining, q.condition);
    if (name === null) continue;
    const cap = capacity[name];
    remaining[name].ICU -= 1;
    actions.push({
      type: "divert_to",
      patientId: q.patientId,
      hospital: name,
      confidence: cap.confidence,
      reason: `ICU has no free bed this hour; ${name} can accept (confidence ${cap.confidence.toFixed(2)}).`,
    });
  }
  if (!actions.length) return null;
  return {
    unit: "ICU",
    author: REGIONAL_AUTHOR,
    actions,
    rationale: "Suggested diverts for patients ICU cannot accommodate this hour.",
    confidence: Math.min(...actions.map((a) => a.confidence)),
    risks: ["patient transport time", "records must follow"],
  };
}

/** Only one plan can wait: a still-pending plan expires when the next one is made. */
export function expirePending(state) {
  for (const b of state.bundles) {
    if (b.status !== "pending") continue;
    b.status = "expired";
    b.decidedTime = clock(state.tick);
    state.addLog("Coordinator", "info", `${b.hourRange} plan expired without a decision`);
  }
}

function logBlocked(state, entries) {
  for (const e of entries) {
    if (e.blocked) state.addLog("Safety check", "block", `blocked ${e.author}'s "${actionLabel(e.action.type)}": ${e.rule}`);
  }
}

/** Build this hour's plan from the planners' proposals and the hospitals' capacity answers. */
export function buildBundle(state, proposals, hospitalCapacity) {
  expirePending(state);
  // A proposal without an actions list proposes nothing (the safety check still flags its shape).
  proposals = proposals.map((p) => (Array.isArray(p.actions) ? p : { ...p, actions: [] }));

  for (const p of proposals) {
    state.addLog(p.author, "info", p.actions.length ? `proposed ${p.actions.length === 1 ? "1 action" : `${p.actions.length} actions`}: ${p.rationale}` : p.rationale);
  }
  const resolved = resolveConflicts(state, proposals);

  // Record this hour's nearby capacity first: the safety check verifies diverts against it.
  state.nearbyCapacity = structuredClone(hospitalCapacity);
  for (const [name, cap] of Object.entries(hospitalCapacity)) {
    state.addLog(
      name,
      "info",
      `can accept ${cap.canAccept.ICU ?? 0} ICU / ${cap.canAccept.Ward ?? 0} Ward until ${cap.validUntil} ` +
        `(confidence ${cap.confidence.toFixed(2)}). ${cap.note ?? ""}`.trim(),
    );
  }
  state.addLog(
    REGIONAL_AUTHOR,
    "info",
    `compiled nearby capacity from ${Object.keys(hospitalCapacity).length} hospitals`,
  );

  const first = safety.evaluate(resolved, state);
  logBlocked(state, first.entries);
  let entries = first.entries;
  let allowedProposals = first.proposals;
  let after = first.after;

  const divert = suggestDiverts(state, allowedProposals, hospitalCapacity, first);
  if (divert) {
    state.addLog(
      REGIONAL_AUTHOR,
      "info",
      `suggested ${divert.actions.length === 1 ? "1 divert" : `${divert.actions.length} diverts`} ` +
        "for ICU patients who can't be taken locally this hour",
    );
    const second = safety.evaluate([divert], state, {
      startingOccupied: after,
      divertsUsed: first.divertsUsed,
      movedPatients: first.movedPatients,
    });
    logBlocked(state, second.entries);
    entries = entries.concat(second.entries);
    allowedProposals = allowedProposals.concat(second.proposals.filter((p) => p.actions.length));
    after = second.after;
  }

  const nBlocked = entries.filter((e) => e.blocked).length;
  const hourRange = formatHourRange(state.tick);
  const summary = entries.length
    ? `${hourRange}: ${entries.length - nBlocked}/${entries.length} actions cleared by the Safety check`
    : `${hourRange}: no actions this hour`;
  const rows = allowedProposals.flatMap((p) => p.actions.map((a) => planRow(state, p, a)));

  const bundle = {
    id: state.nextBundleId,
    tick: state.tick,
    hourRange,
    summary,
    proposals: allowedProposals,
    safety: entries,
    rows,
    overallConfidence: rows.length ? Math.min(...rows.map((r) => r.confidence)) : null,
    nearbyCapacity: Object.entries(hospitalCapacity).map(([name, cap]) => ({ ...structuredClone(cap), hospital: name })),
    before: first.before,
    after,
    status: "pending",
    reason: null,
    decidedTime: null,
  };
  state.nextBundleId += 1;
  state.bundles.push(bundle);
  if (state.bundles.length > BUNDLE_LIMIT) state.bundles.splice(0, state.bundles.length - BUNDLE_LIMIT);
  state.addLog("Coordinator", "info", summary);
  return bundle;
}
