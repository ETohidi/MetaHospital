// Tick simulation of the own hospital's census: arrivals, waiting, discharges, and the
// bus-accident emergency. Every random draw goes through state.rng.

import { UNITS } from "../data/places.js";

export const CONDITIONS = ["trauma", "cardiac", "respiratory", "stroke", "infection", "other"];
export const SURGE_TRAUMA_PROBABILITY = 0.8; // a bus accident is mostly trauma, not exclusively

// Calibrated so that a day where the charge nurse approves plans stays near the seeded
// occupancy instead of draining (see test/calibration.test.js).
export const LOS_RANGES = { ED: [2, 6], ICU: [3, 10], Ward: [4, 12] };
export const ARRIVAL_MEANS = { ED: 7, ICU: 1, Ward: 6 };
export const ARRIVAL_ACUITY_WEIGHTS = {
  ED: { 1: 0.25, 2: 0.3, 3: 0.25, 4: 0.15, 5: 0.05 },
  ICU: { 3: 0.2, 4: 0.5, 5: 0.3 },
  Ward: { 1: 0.4, 2: 0.35, 3: 0.25 },
};

export const SURGE_ARRIVALS = 20;
// Triage of the casualties: mostly walking wounded and urgent cases, a few critical.
export const SURGE_ACUITY_WEIGHTS = { 2: 0.3, 3: 0.35, 4: 0.25, 5: 0.1 };
export const SURGE_MESSAGE = "bus accident, 20 casualties";
export const SURGE_DURATION_TICKS = 3;
// Wider/shifted than the normal ED range so surge patients don't all leave in the same
// hour (that would swing ED from >100% straight past the 70-95% band in one step).
export const SURGE_LOS_RANGE = [2.0, 5.0];

// An approved divert_ed halves ambulance arrivals at the ED for this many hours.
export const ED_DIVERT_TICKS = 2;

// ED patients who need a bed upstairs: acuity 4-5 wait for ICU, 3 for the Ward; 1-2 go home.
export const ICU_ADMIT_MIN_ACUITY = 4;
export const WARD_ADMIT_MIN_ACUITY = 3;
// A patient waiting in the ED for a bed upstairs keeps their ED bed until they are moved,
// but after this many hours the ED team transfers them out of the network.
export const MAX_BOARDING_TICKS = 6;

export function weightedChoice(rng, weights) {
  return rng.choices(weights);
}

export function sampleCondition(rng) {
  return rng.choice(CONDITIONS);
}

export function sampleSurgeCondition(rng) {
  if (rng.random() < SURGE_TRAUMA_PROBABILITY) return "trauma";
  return rng.choice(CONDITIONS);
}

function sampleLosRange(rng, lo, hi) {
  const mid = (lo + hi) / 2;
  const val = Math.min(Math.max(rng.lognormvariate(Math.log(mid), 0.4), lo), hi);
  return Math.max(1, Math.round(val));
}

export function sampleLos(rng, unit) {
  return sampleLosRange(rng, ...LOS_RANGES[unit]);
}

export function sampleSurgeLos(rng) {
  return sampleLosRange(rng, ...SURGE_LOS_RANGE);
}

/** ED patients who need a bed upstairs wait in that unit's queue. */
export function queueEdPatient(state, patientId, acuity, condition) {
  const entry = { patientId, from: "ED", acuity, condition, waitingTicks: 0 };
  if (acuity >= ICU_ADMIT_MIN_ACUITY) state.units.ICU.queue.push(entry);
  else if (acuity >= WARD_ADMIT_MIN_ACUITY) state.units.Ward.queue.push(entry);
}

function arrive(state, unit, n) {
  const rng = state.rng;
  for (let i = 0; i < n; i++) {
    const acuity = weightedChoice(rng, ARRIVAL_ACUITY_WEIGHTS[unit]);
    const condition = sampleCondition(rng);
    const los = sampleLos(rng, unit);
    const patient = state.addPatient({
      unit,
      acuity,
      condition,
      admitTick: state.tick,
      expectedDischargeTick: state.tick + los,
    });
    if (unit === "ED") queueEdPatient(state, patient.id, acuity, condition);
  }
}

function processDischarges(state, tick) {
  const discharges = { ED: 0, ICU: 0, Ward: 0 };
  const waiting = new Map();
  for (const u of Object.values(state.units)) for (const q of u.queue) waiting.set(q.patientId, q);

  let transferredOut = 0;
  for (const p of [...state.patients.values()]) {
    const q = waiting.get(p.id);
    if (q && q.waitingTicks < MAX_BOARDING_TICKS) continue; // still waiting for a bed upstairs
    if (q) transferredOut += 1;
    else if (p.expectedDischargeTick > tick) continue;
    discharges[p.unit] += 1;
    state.removePatient(p.id);
  }
  if (transferredOut) {
    const who = transferredOut === 1 ? "1 patient" : `${transferredOut} patients`;
    state.addLog(
      "Simulation",
      "warn",
      `${who} waited ${MAX_BOARDING_TICKS} hours in the ED for a bed upstairs and ${transferredOut === 1 ? "was" : "were"} transferred out by the ED team.`,
    );
  }
  return discharges;
}

export function arrivalMean(state, unit) {
  if (unit === "ED" && state.edDivertTicksRemaining > 0) return ARRIVAL_MEANS.ED / 2;
  return ARRIVAL_MEANS[unit];
}

/** Advance the hospital by one hour. */
export function step(state) {
  state.tick += 1;
  const tick = state.tick;

  if (state.surgeTicksRemaining > 0) {
    state.surgeTicksRemaining -= 1;
    if (state.surgeTicksRemaining === 0) state.surgeMessage = null;
  }

  const arrivals = {};
  for (const unit of UNITS) {
    const n = state.rng.poisson(arrivalMean(state, unit));
    arrive(state, unit, n);
    arrivals[unit] = n;
  }
  if (state.edDivertTicksRemaining > 0) {
    state.edDivertTicksRemaining -= 1;
    if (state.edDivertTicksRemaining === 0) {
      state.addLog("Simulation", "info", "Ambulance diversion ended; the ED takes all arrivals again.");
    }
  }

  for (const u of Object.values(state.units)) {
    for (const q of u.queue) q.waitingTicks += 1;
  }

  const discharges = processDischarges(state, tick);
  state.fillBeds();
  state.driftNeighbours();
  state.recentDischarges = UNITS.filter((u) => discharges[u] > 0);
  state.recordHistory(arrivals, discharges);
  state.recordHospitalHistory();
}

/** The bus accident: 20 casualties arrive at the ED at once. */
export function injectSurge(state) {
  const rng = state.rng;
  for (let i = 0; i < SURGE_ARRIVALS; i++) {
    const acuity = rng.choices(SURGE_ACUITY_WEIGHTS);
    const condition = sampleSurgeCondition(rng);
    const los = sampleSurgeLos(rng);
    const patient = state.addPatient({
      unit: "ED",
      acuity,
      condition,
      admitTick: state.tick,
      expectedDischargeTick: state.tick + los,
      surge: true,
    });
    queueEdPatient(state, patient.id, acuity, condition);
  }
  state.surgeMessage = SURGE_MESSAGE;
  state.surgeTicksRemaining = SURGE_DURATION_TICKS;
  state.countSurgeInHistory(SURGE_ARRIVALS);
  state.addLog("Simulation", "warn", `Emergency scenario: ${SURGE_MESSAGE} (+${SURGE_ARRIVALS} ED arrivals)`);
}
