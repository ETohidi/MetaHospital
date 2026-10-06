// Rule-based unit planners: each reads its unit's census and proposes actions for the
// next hour. Canned but sensible, and deliberately imperfect in one place (ED asks for a
// divert too early) so the safety check has something real to catch.

import { UNIT_PLANNER_NAME } from "./state.js";
import { DIVERT_ED_THRESHOLD } from "./safety.js";
import { ED_DIVERT_TICKS } from "./sim.js";

// Below the safety check's hard 95% cutoff but above this, ED still proposes divert_ed -
// a premature ask the safety check blocks. At plan time ED averages about 72% on a normal
// day (the hour's admissions are still waiting downstairs), so this fires in roughly one
// normal hour in ten; the main premature ask is the one after an approved diversion.
export const ED_DIVERT_PREVIEW_THRESHOLD = 0.9;

export const ICU_HINT_NOTE =
  "Charge nurse asked us to look at nearby hospitals; the Regional coordinator will offer receiving hospitals.";

const pct = (x) => `${Math.round(x * 100)}%`;

function withRejectionNote(rationale, recentRejections) {
  if (recentRejections.length) {
    return `${rationale} (Noting recent rejection: ${recentRejections[recentRejections.length - 1]})`;
  }
  return rationale;
}

function proposal(unit, actions, rationale, confidence, risks = []) {
  return { unit, author: UNIT_PLANNER_NAME[unit], actions, rationale, confidence, risks };
}

/** Waiting patients this unit has usable beds for, in the given priority order. */
function admissible(census, order) {
  const free = Math.max(0, census.bedsStaffed - census.bedsOccupied);
  return [...census.queue].sort(order).slice(0, free);
}

const sickestFirst = (a, b) => b.acuity - a.acuity || b.waitingTicks - a.waitingTicks;
const longestWaitingFirst = (a, b) => b.waitingTicks - a.waitingTicks || b.acuity - a.acuity;

function acceptAll(unit, patients, confidence, bedWord) {
  return patients.map((q) => ({
    type: "accept_transfer",
    patientId: q.patientId,
    from: q.from,
    confidence,
    reason: `${q.condition} patient, acuity ${q.acuity}; ${bedWord} bed available.`,
  }));
}

const patientCount = (n) => (n === 1 ? "1 waiting patient" : `${n} waiting patients`);

function generateIcu(census, recentRejections) {
  const withHint = (text) => (census.hint ? `${text} ${ICU_HINT_NOTE}` : text);
  const taking = admissible(census, sickestFirst);
  if (taking.length) {
    const confidence = 0.75;
    const left = census.queue.length - taking.length;
    const rationale =
      `Taking ${patientCount(taking.length)}, sickest first.` +
      (left ? ` ${left} more can't get an ICU bed this hour.` : "");
    return proposal(
      "ICU",
      acceptAll("ICU", taking, confidence, "ICU"),
      withRejectionNote(withHint(rationale), recentRejections),
      confidence,
      ["queue estimate may be stale"],
    );
  }
  const why = census.queue.length ? "No free ICU beds; holding position." : "Nobody is waiting for an ICU bed.";
  return proposal("ICU", [], withRejectionNote(withHint(why), recentRejections), 0.5);
}

function generateEd(census, recentRejections, { rising = false, diverting = false } = {}) {
  const occ = census.bedsStaffed ? census.bedsOccupied / census.bedsStaffed : 0;
  // Any recent pushback from the charge nurse makes ED more conservative about asking to
  // divert again, whatever the wording of the reason.
  const avoidDivert = recentRejections.length > 0;
  const risks = ["ambulance diversion delays regional care"];
  const trend = rising ? " and rising" : "";

  if (occ > DIVERT_ED_THRESHOLD) {
    const confidence = 0.85;
    return proposal(
      "ED",
      [
        {
          type: "divert_ed",
          confidence,
          reason: `ED at ${pct(occ)} of usable beds; the whole unit is full, not one patient.`,
        },
      ],
      withRejectionNote(`ED at ${pct(occ)} of usable beds; diverting incoming ambulances.`, recentRejections),
      confidence,
      risks,
    );
  }
  if (diverting && !avoidDivert) {
    // Ambulances are already being diverted: ED asks to keep it that way, even though it
    // is no longer full. The safety check refuses, since the ED is under 95% now.
    const confidence = 0.55;
    return proposal(
      "ED",
      [
        {
          type: "divert_ed",
          confidence,
          reason: `ED at ${pct(occ)} of usable beds; keep diverting ambulances until the emergency backlog clears.`,
        },
      ],
      withRejectionNote(
        `Ambulances are still diverted and ED is at ${pct(occ)} of usable beds; asking to keep diverting for another ${ED_DIVERT_TICKS} hours.`,
        recentRejections,
      ),
      confidence,
      risks,
    );
  }
  if (occ > ED_DIVERT_PREVIEW_THRESHOLD && !avoidDivert) {
    const confidence = 0.6;
    return proposal(
      "ED",
      [
        {
          type: "divert_ed",
          confidence,
          reason: `ED at ${pct(occ)} of usable beds${trend}; the whole unit, not one patient.`,
        },
      ],
      withRejectionNote(
        `ED at ${pct(occ)} of usable beds${trend}; diverting ambulances before we're overwhelmed.`,
        recentRejections,
      ),
      confidence,
      risks,
    );
  }
  if (occ > ED_DIVERT_PREVIEW_THRESHOLD) {
    // The charge nurse recently rejected a plan: ask for help instead of diverting again.
    const confidence = 0.7;
    return proposal(
      "ED",
      [
        {
          type: "request_beds",
          beds: 3,
          urgency: "high",
          confidence,
          reason: `ED at ${pct(occ)} of usable beds; asking for help instead of diverting again.`,
        },
      ],
      withRejectionNote("ED under pressure; requesting beds from downstream units.", recentRejections),
      confidence,
      ["boarding times increase"],
    );
  }
  return proposal(
    "ED",
    [],
    withRejectionNote("ED occupancy within normal range; no action needed.", recentRejections),
    0.6,
  );
}

function generateWard(census, recentRejections) {
  const taking = admissible(census, longestWaitingFirst);
  if (taking.length) {
    const confidence = 0.65;
    const left = census.queue.length - taking.length;
    const rationale =
      `Taking ${patientCount(taking.length)} into free Ward beds, longest wait first.` +
      (left ? ` ${left} more wait for the next free bed.` : "");
    return proposal("Ward", acceptAll("Ward", taking, confidence, "Ward"), withRejectionNote(rationale, recentRejections), confidence);
  }
  const why = census.queue.length ? "No free Ward beds this hour." : "No action needed this hour.";
  return proposal("Ward", [], withRejectionNote(why, recentRejections), 0.55);
}

const GENERATORS = { ED: generateEd, ICU: generateIcu, Ward: generateWard };

/** The unit planner's proposal for the coming hour. */
export function generate(unit, state) {
  const census = state.census(unit);
  return GENERATORS[unit](census, census.recentRejections, {
    rising: isRising(state, unit),
    diverting: unit === "ED" && state.edDivertTicksRemaining > 0,
  });
}

/** Whether the unit has more patients now than an hour ago. */
function isRising(state, unit) {
  const hist = state.history[unit];
  if (hist.length < 2) return false;
  return state.occupied(unit) > hist[hist.length - 2].inUse;
}

/** Same, from a census object directly (for tests and what-ifs). */
export function generateFromCensus(census) {
  return GENERATORS[census.unit](census, census.recentRejections);
}
