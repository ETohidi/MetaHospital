// The safety check: deterministic rules every proposed action must pass before it can
// reach the charge nurse. Blocked actions stay visible in the plan with the rule's text.

import { UNITS } from "../data/places.js";
import { OWN_HOSPITAL_NAME } from "./state.js";

export const RULE_STAFFED_CAP = "A unit can't take more patients than it has usable beds today.";
export const RULE_EXPEDITE_DISCHARGE = "No early discharge for patients who arrived under 2 hours ago or have acuity 4 or 5.";
export const RULE_EXPEDITE_TARGET = "An early discharge needs a discharge time later than now and earlier than planned.";
export const RULE_OVERFLOW_CAP = "A unit can open at most 2 overflow beds per hour.";
export const RULE_DIVERT_ED = "Ambulances are only diverted while the ED is more than 95% full.";
export const RULE_PROPOSAL_SHAPE =
  "Every proposal needs a known unit, a reason, a confidence between 0 and 1, and actions of a known type.";
export const RULE_DIVERT_TO_NO_HOSPITAL = "Sending a patient to another hospital needs that hospital's name.";
export const RULE_DIVERT_TO_OWN = "Sending a patient to another hospital can't name our own hospital.";
export const RULE_DIVERT_TO_CAPACITY = "The receiving hospital hasn't reported a free bed for this patient.";
export const RULE_ACCEPT_TRANSFER_QUEUE = "A unit can only take a patient who is waiting for one of its beds.";
export const RULE_DIVERT_TO_PATIENT = "Sending a patient to another hospital needs a patient who is in our hospital.";
export const RULE_ONE_MOVE = "A patient can only be moved, sent away or discharged once per hour.";

export const MAX_OVERFLOW_PER_TICK = 2;
export const DIVERT_ED_THRESHOLD = 0.95;
export const MIN_STAY_TICKS = 2;
export const EXPEDITE_MAX_ACUITY = 4;

const copy = (x) => structuredClone(x);

function entry(proposal, action, blocked, rule) {
  return { unit: proposal.unit, author: proposal.author, action: copy(action), blocked, rule };
}

const isConfidence = (c) => typeof c === "number" && c >= 0 && c <= 1;

function validShape(p) {
  return (
    UNITS.includes(p.unit) &&
    Array.isArray(p.actions) &&
    typeof p.rationale === "string" &&
    p.rationale.trim() !== "" &&
    isConfidence(p.confidence) &&
    p.actions.every((a) => a && typeof a === "object" && (a.confidence == null || isConfidence(a.confidence)))
  );
}

/**
 * Check proposals against the rules, projecting occupancy as allowed actions apply.
 *
 * A second pass (the Regional coordinator's diverts, evaluated after the unit planners)
 * continues from the first pass via `startingOccupied`, `divertsUsed` and `movedPatients`.
 * `before` is always the true current occupancy.
 *
 * @returns {{entries: object[], proposals: object[], before: object, after: object,
 *            staffed: object, divertsUsed: object, movedPatients: string[]}}
 */
export function evaluate(proposals, state, { startingOccupied = null, divertsUsed = {}, movedPatients = [] } = {}) {
  const tick = state.tick;
  const before = Object.fromEntries(UNITS.map((u) => [u, state.occupied(u)]));
  const occupied = { ...(startingOccupied ?? before) };
  const staffed = Object.fromEntries(UNITS.map((u) => [u, state.units[u].bedsStaffed]));
  const overflowUsed = { ED: 0, ICU: 0, Ward: 0 };
  const used = structuredClone(divertsUsed); // hospital -> unit -> diverts already planned
  const moved = new Set(movedPatients); // patients an allowed action already moves this hour
  const entries = [];

  const valid = [];
  for (const p of proposals) {
    if (!validShape(p)) {
      const actions = Array.isArray(p.actions) ? p.actions.filter((a) => a && typeof a === "object") : [];
      for (const a of actions) entries.push(entry(p, a, true, RULE_PROPOSAL_SHAPE));
    } else {
      valid.push(p);
    }
  }

  const allowed = new Map(); // "i:j" -> the checked copy of the action
  const key = (i, j) => `${i}:${j}`;

  // Pass 1: open_overflow first, so it can raise capacity for pass 2.
  valid.forEach((p, i) => {
    p.actions.forEach((a, j) => {
      if (a.type !== "open_overflow") return;
      const beds = a.beds ?? 0;
      let rule = null;
      if (!Number.isInteger(beds) || beds <= 0 || overflowUsed[p.unit] + beds > MAX_OVERFLOW_PER_TICK) {
        rule = RULE_OVERFLOW_CAP;
      } else {
        overflowUsed[p.unit] += beds;
        staffed[p.unit] += beds;
        allowed.set(key(i, j), copy(a));
      }
      entries.push(entry(p, a, rule !== null, rule));
    });
  });

  // Pass 2: everything else.
  valid.forEach((p, i) => {
    p.actions.forEach((a, j) => {
      if (a.type === "open_overflow") return;
      const checked = copy(a); // checkAction may correct it (accept_transfer's `from`)
      const rule = checkAction(p, checked, { state, tick, occupied, staffed, used, moved });
      if (rule === null) allowed.set(key(i, j), checked);
      entries.push(entry(p, checked, rule !== null, rule));
    });
  });

  const filtered = valid.map((p, i) => ({
    ...copy(p),
    actions: p.actions.flatMap((_, j) => (allowed.has(key(i, j)) ? [copy(allowed.get(key(i, j)))] : [])),
  }));

  return { entries, proposals: filtered, before, after: occupied, staffed, divertsUsed: used, movedPatients: [...moved] };
}

/** The rule text that blocks this action, or null. Updates the projection when allowed. */
function checkAction(p, a, { state, tick, occupied, staffed, used, moved }) {
  switch (a.type) {
    case "accept_transfer": {
      const patient = state.patients.get(a.patientId);
      const queued = state.units[p.unit].queue.find((q) => q.patientId === a.patientId);
      if (!patient || !queued) return RULE_ACCEPT_TRANSFER_QUEUE;
      if (moved.has(a.patientId)) return RULE_ONE_MOVE;
      if (occupied[p.unit] + 1 > staffed[p.unit]) return RULE_STAFFED_CAP;
      occupied[p.unit] += 1;
      // The queue knows where the patient really is, whatever the action claims; the
      // plan, family message and transfer animation use it too.
      if (queued.from in occupied) occupied[queued.from] = Math.max(0, occupied[queued.from] - 1);
      a.from = queued.from;
      moved.add(a.patientId);
      return null;
    }
    case "expedite_discharge": {
      const patient = state.patients.get(a.patientId);
      if (
        !patient ||
        patient.unit !== p.unit ||
        tick - patient.admitTick < MIN_STAY_TICKS ||
        patient.acuity >= EXPEDITE_MAX_ACUITY
      ) {
        return RULE_EXPEDITE_DISCHARGE;
      }
      if (!Number.isInteger(a.targetTick) || a.targetTick <= tick || a.targetTick >= patient.expectedDischargeTick) {
        return RULE_EXPEDITE_TARGET;
      }
      if (moved.has(a.patientId)) return RULE_ONE_MOVE;
      moved.add(a.patientId);
      return null;
    }
    case "divert_ed": {
      const staffedEd = staffed.ED || 1;
      return occupied.ED / staffedEd <= DIVERT_ED_THRESHOLD ? RULE_DIVERT_ED : null;
    }
    case "divert_to": {
      if (!a.hospital) return RULE_DIVERT_TO_NO_HOSPITAL;
      if (a.hospital === OWN_HOSPITAL_NAME) return RULE_DIVERT_TO_OWN;
      const patient = state.patients.get(a.patientId);
      if (!patient) return RULE_DIVERT_TO_PATIENT;
      if (moved.has(a.patientId)) return RULE_ONE_MOVE;
      const targetUnit = patient.acuity >= 4 ? "ICU" : "Ward";
      const capacity = state.nearbyCapacity[a.hospital]?.canAccept?.[targetUnit] ?? 0;
      const already = used[a.hospital]?.[targetUnit] ?? 0;
      if (capacity - already <= 0) return RULE_DIVERT_TO_CAPACITY;
      used[a.hospital] = { ...used[a.hospital], [targetUnit]: already + 1 };
      if (patient.unit in occupied) occupied[patient.unit] = Math.max(0, occupied[patient.unit] - 1);
      moved.add(a.patientId);
      return null;
    }
    case "defer_transfer":
    case "request_beds":
    case "defer_elective":
      return null; // unconstrained
    default:
      return RULE_PROPOSAL_SHAPE; // unknown action type
  }
}
