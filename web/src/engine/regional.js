// Rule-based hospital capacity answers for the Regional coordinator: each hospital (ours
// included) says how many ICU / Ward patients it could take, conservatively.

import { CONDITIONS } from "./sim.js";

export const VALID_FOR_TICKS = 2;
export const CONSERVATIVE_HOLDBACK = 2; // keep this many usable beds free even when reporting capacity

export function generate(hospitalName, state) {
  const census = state.hospitalCensus(hospitalName);
  const free = census.freeBeds;
  const emergency = census.emergency;

  let canAccept = {
    ICU: Math.max(0, (free.ICU ?? 0) - CONSERVATIVE_HOLDBACK),
    Ward: Math.max(0, (free.Ward ?? 0) - CONSERVATIVE_HOLDBACK),
  };
  if (emergency) {
    // An emergency of its own: hold back harder.
    canAccept = { ICU: Math.max(0, canAccept.ICU - 2), Ward: Math.max(0, canAccept.Ward - 2) };
  }

  let confidence = emergency ? 0.5 : 0.85;
  if ((free.ICU ?? 0) + (free.Ward ?? 0) <= CONSERVATIVE_HOLDBACK) confidence = Math.min(confidence, 0.4);

  const note = `${free.ICU ?? 0} ICU / ${free.Ward ?? 0} Ward beds free right now${
    emergency ? `; ${emergency} in progress here too` : ""
  }.`;

  return {
    hospital: hospitalName,
    canAccept,
    validUntil: state.clock.time(state.tick + VALID_FOR_TICKS),
    conditionsPreferred: state.rng.sample(CONDITIONS, 2),
    confidence,
    note,
  };
}
