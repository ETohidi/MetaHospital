// In-memory state of the twin: the own hospital's patients and units (with bed numbers),
// the neighbour hospitals' bed counts, plans, log, family messages and history.

import { HOSPITAL_BY_NAME, HOSPITALS, OWN_HOSPITAL, UNITS } from "../data/places.js";
import { DEFAULT_START_MS, makeClock } from "./clock.js";
import { hashFloat } from "./rng.js";
import * as sim from "./sim.js";

export const OWN_HOSPITAL_NAME = OWN_HOSPITAL.name;
export const HOSPITAL_NAMES = HOSPITALS.map((h) => h.name);
export const NEIGHBOUR_NAMES = HOSPITALS.filter((h) => !h.isOwn).map((h) => h.name);

// Display name of a unit acting as a proposer; the unit itself stays "ED"/"ICU"/"Ward".
export const UNIT_PLANNER_NAME = { ED: "ED planner", ICU: "ICU planner", Ward: "Ward planner" };

// A charge-nurse rejection shapes the planners' next proposals for this many hours.
export const REJECTION_MEMORY_TICKS = 4;
const MAX_REJECTIONS = 5;
const LOG_LIMIT = 2000;
const FAMILY_LIMIT = 20;
const HISTORY_LIMIT = 24 * 7; // a week of hourly rows per unit / hospital
// Each hour a neighbour closes this share of the gap to its usual occupancy (so a spike
// to full clears within a few hours), and has this chance of a sudden spike to full.
export const NEIGHBOUR_REVERSION = 0.2;
export const NEIGHBOUR_SPIKE_PROBABILITY = 0.02;

export const idNumber = (id) => Number(id.slice(1));

export class TwinState {
  constructor({ seed, rng, startMs = DEFAULT_START_MS }) {
    this.seed = seed;
    this.rng = rng;
    /** German wall clock for this twin; tick 0 is startMs. */
    this.clock = makeClock(startMs);
    this.tick = 0;
    this.nextPatientId = 1;
    this.nextBundleId = 1;
    /** @type {Map<string, object>} */
    this.patients = new Map();
    this.units = Object.fromEntries(
      UNITS.map((u) => {
        const [bedsTotal, bedsStaffed] = OWN_HOSPITAL.seed[u];
        return [u, { name: u, bedsTotal, bedsStaffed, queue: [], rejections: [] }];
      }),
    );
    this.bundles = [];
    this.log = [];
    this.familyMessages = [];
    this.surgeMessage = null;
    this.surgeTicksRemaining = 0;
    this.edDivertTicksRemaining = 0;
    this.pendingRequests = [];
    this.neighbours = Object.fromEntries(
      HOSPITALS.filter((h) => !h.isOwn).map((h) => [
        h.name,
        Object.fromEntries(
          UNITS.map((u) => {
            const [bedsTotal, bedsStaffed, bedsOccupied] = h.seed[u];
            return [u, { bedsTotal, bedsStaffed, bedsOccupied }];
          }),
        ),
      ]),
    );
    // Last answer from each hospital (ours included), refreshed by the Regional coordinator every tick.
    this.nearbyCapacity = {};
    this.history = Object.fromEntries(UNITS.map((u) => [u, []]));
    this.hospitalHistory = Object.fromEntries(HOSPITAL_NAMES.map((n) => [n, []]));
    this.recentTransfers = [];
    this.recentDischarges = [];
    this.recentProposals = [];

    this.seedPatients();
    this.recordHistory({}, {});
    this.recordHospitalHistory();
  }

  seedPatients() {
    const rng = this.rng;
    const edPatients = [];
    for (const unit of UNITS) {
      const occupied = OWN_HOSPITAL.seed[unit][2];
      for (let i = 0; i < occupied; i++) {
        const acuity = sim.weightedChoice(rng, sim.ARRIVAL_ACUITY_WEIGHTS[unit]);
        const condition = sim.sampleCondition(rng);
        const los = sim.sampleLos(rng, unit);
        const remaining = rng.randint(1, los);
        const patient = this.addPatient({
          unit,
          acuity,
          condition,
          admitTick: remaining - los,
          expectedDischargeTick: remaining,
        });
        if (unit === "ED") edPatients.push(patient);
      }
    }
    const icuCandidate = edPatients.find((p) => p.acuity >= sim.ICU_ADMIT_MIN_ACUITY);
    if (icuCandidate) this.units.ICU.queue.push(queueEntry(icuCandidate, 2));
    const wardCandidate = edPatients.find(
      (p) => p.acuity >= sim.WARD_ADMIT_MIN_ACUITY && p.acuity < sim.ICU_ADMIT_MIN_ACUITY,
    );
    if (wardCandidate) this.units.Ward.queue.push(queueEntry(wardCandidate, 1));
  }

  // -- patients and beds ------------------------------------------------------
  newPatientId() {
    const id = `p${String(this.nextPatientId).padStart(3, "0")}`;
    this.nextPatientId += 1;
    return id;
  }

  /** Admit a new patient into a unit; they take the lowest free bed, if any. */
  addPatient({ unit, acuity, condition, admitTick, expectedDischargeTick, surge = false }) {
    const patient = {
      id: this.newPatientId(),
      unit,
      acuity,
      condition,
      admitTick,
      expectedDischargeTick,
      bed: this.lowestFreeBed(unit),
      surge,
    };
    this.patients.set(patient.id, patient);
    return patient;
  }

  /** Remove a patient from the hospital (discharge or transfer out) and from every queue. */
  removePatient(patientId) {
    this.patients.delete(patientId);
    this.dequeue(patientId);
  }

  dequeue(patientId) {
    for (const u of Object.values(this.units)) {
      u.queue = u.queue.filter((q) => q.patientId !== patientId);
    }
  }

  /** Move a patient into another unit and its lowest free bed. */
  movePatient(patient, unit) {
    patient.bed = null;
    patient.unit = unit;
    patient.bed = this.lowestFreeBed(unit);
  }

  unitPatients(unit) {
    return [...this.patients.values()].filter((p) => p.unit === unit);
  }

  occupied(unit) {
    let n = 0;
    for (const p of this.patients.values()) if (p.unit === unit) n += 1;
    return n;
  }

  lowestFreeBed(unit) {
    const taken = new Set(this.unitPatients(unit).map((p) => p.bed));
    for (let bed = 1; bed <= this.units[unit].bedsStaffed; bed++) {
      if (!taken.has(bed)) return bed;
    }
    return null;
  }

  /** Put bedless patients into beds that have freed up, oldest admission first. */
  fillBeds() {
    for (const unit of UNITS) {
      const waiting = this.unitPatients(unit)
        .filter((p) => p.bed === null)
        .sort((a, b) => a.admitTick - b.admitTick || idNumber(a.id) - idNumber(b.id));
      for (const p of waiting) {
        const bed = this.lowestFreeBed(unit);
        if (bed === null) break;
        p.bed = bed;
      }
    }
  }

  // -- log and messages --------------------------------------------------------
  time() {
    return this.clock.time(this.tick);
  }

  dayTime() {
    return this.clock.dayTime(this.tick);
  }

  addLog(actor, level, text) {
    this.log.push({ tick: this.tick, time: this.time(), actor, text, level });
    if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT);
  }

  addFamilyMessage(text) {
    this.familyMessages.push({ tick: this.tick, time: this.time(), text });
    this.familyMessages = this.familyMessages.slice(-FAMILY_LIMIT);
  }

  // -- rejections -----------------------------------------------------------------
  addRejection(unit, text) {
    const u = this.units[unit];
    u.rejections.push({ text, tick: this.tick });
    u.rejections = u.rejections.slice(-MAX_REJECTIONS);
  }

  /** Rejection reasons still remembered (from the last REJECTION_MEMORY_TICKS hours), oldest first. */
  activeRejections(unit) {
    return this.units[unit].rejections
      .filter((r) => this.tick - r.tick < REJECTION_MEMORY_TICKS)
      .slice(-MAX_REJECTIONS)
      .map((r) => r.text);
  }

  // -- census ------------------------------------------------------------------------
  census(unit) {
    const u = this.units[unit];
    if (!u) throw new Error(`Unknown unit ${unit}`);
    const discharges = this.unitPatients(unit)
      .sort((a, b) => a.expectedDischargeTick - b.expectedDischargeTick)
      .slice(0, 10)
      .map((p) => ({
        patientId: p.id,
        acuity: p.acuity,
        condition: p.condition,
        etaTime: this.clock.time(p.expectedDischargeTick),
      }));
    const requests = this.pendingRequests.filter((r) => r.unit !== unit).slice(-5);
    const recentRejections = this.activeRejections(unit);
    const hint = recentRejections.some((r) => r.toLowerCase().includes("nearby hospital"))
      ? "The charge nurse suggested a nearby hospital could take this patient - " +
        "check Nearby capacity before proposing local actions."
      : null;
    return {
      tick: this.tick,
      time: this.time(),
      unit,
      bedsTotal: u.bedsTotal,
      bedsOccupied: this.occupied(unit),
      bedsStaffed: u.bedsStaffed,
      expectedDischarges: discharges,
      queue: u.queue.map((q) => ({ ...q })),
      requestsFromOthers: requests.map((r) => ({ unit: r.unit, beds: r.beds, urgency: r.urgency })),
      recentRejections,
      surge: this.surgeMessage,
      hint,
    };
  }

  /** What a hospital (ours or a neighbour) is asked about by the Regional coordinator. */
  hospitalCensus(name) {
    let freeBeds;
    let discharges3h;
    let emergency = null;
    if (name === OWN_HOSPITAL_NAME) {
      freeBeds = Object.fromEntries(UNITS.map((u) => [u, Math.max(0, this.units[u].bedsStaffed - this.occupied(u))]));
      discharges3h = {};
      for (const u of ["ICU", "Ward"]) {
        discharges3h[u] = this.unitPatients(u).filter(
          (p) => this.tick < p.expectedDischargeTick && p.expectedDischargeTick <= this.tick + 3,
        ).length;
      }
      emergency = this.surgeMessage;
    } else {
      const hosp = this.neighbours[name];
      if (!hosp) throw new Error(`Unknown hospital ${name}`);
      freeBeds = Object.fromEntries(UNITS.map((u) => [u, Math.max(0, hosp[u].bedsStaffed - hosp[u].bedsOccupied)]));
      // No patient model for neighbours: a plausible estimate proportional to occupancy.
      // Hash-based rather than drawn from the rng, so asking doesn't change the future.
      discharges3h = {};
      for (const u of ["ICU", "Ward"]) {
        const factor = 0.1 + 0.2 * hashFloat(this.seed, this.tick, name, u);
        discharges3h[u] = Math.round(hosp[u].bedsOccupied * factor);
      }
    }
    return { hospital: name, time: this.time(), freeBeds, expectedDischarges3h: discharges3h, emergency };
  }

  /**
   * Random walk of each neighbour's occupancy that drifts back toward its usual level
   * (its seed occupancy), with a rare sudden spike to full so real shortages still happen.
   */
  driftNeighbours() {
    for (const [name, hosp] of Object.entries(this.neighbours)) {
      const usual = HOSPITAL_BY_NAME[name].seed;
      for (const [unit, u] of Object.entries(hosp)) {
        let delta = this.rng.choice([-2, -1, -1, 0, 0, 0, 1, 1, 2]);
        delta += Math.round((usual[unit][2] - u.bedsOccupied) * NEIGHBOUR_REVERSION);
        u.bedsOccupied = Math.max(0, Math.min(u.bedsStaffed, u.bedsOccupied + delta));
        if (this.rng.random() < NEIGHBOUR_SPIKE_PROBABILITY) u.bedsOccupied = u.bedsStaffed;
      }
    }
  }

  /** Bed counts for all hospitals, ours first (places.js order). */
  hospitalsSummary() {
    return HOSPITALS.map((h) => {
      const units = Object.fromEntries(
        UNITS.map((u) => {
          if (h.isOwn) {
            const s = this.units[u];
            return [u, { bedsTotal: s.bedsTotal, bedsStaffed: s.bedsStaffed, bedsOccupied: this.occupied(u) }];
          }
          return [u, { ...this.neighbours[h.name][u] }];
        }),
      );
      return { id: h.id, name: h.name, isOwn: h.isOwn, units };
    });
  }

  // -- history and projection -----------------------------------------------------------
  recordHospitalHistory() {
    for (const row of this.hospitalsSummary()) {
      const freeBeds = Object.fromEntries(
        UNITS.map((u) => [u, Math.max(0, row.units[u].bedsStaffed - row.units[u].bedsOccupied)]),
      );
      const rows = this.hospitalHistory[row.name];
      rows.push({ tick: this.tick, time: this.time(), dayTime: this.dayTime(), freeBeds });
      if (rows.length > HISTORY_LIMIT) rows.splice(0, rows.length - HISTORY_LIMIT);
    }
  }

  recordHistory(arrivals, discharges) {
    for (const unit of UNITS) {
      const rows = this.history[unit];
      rows.push({
        tick: this.tick,
        time: this.time(),
        dayTime: this.dayTime(),
        inUse: this.occupied(unit),
        usable: this.units[unit].bedsStaffed,
        arrivals: arrivals[unit] ?? 0,
        surgeArrivals: 0,
        discharges: discharges[unit] ?? 0,
        transfersIn: 0,
        transfersOut: 0,
        queueLength: this.units[unit].queue.length,
      });
      if (rows.length > HISTORY_LIMIT) rows.splice(0, rows.length - HISTORY_LIMIT);
    }
  }

  /** Count an approved move in this hour's history row of the unit (see projection()). */
  countTransfer(unit, field) {
    const row = this.history[unit]?.at(-1);
    if (row && row.tick === this.tick) row[field] += 1;
  }

  /** The emergency's casualties count as arrivals in the current hour's history row. */
  countSurgeInHistory(n) {
    const ed = this.history.ED.at(-1);
    if (ed && ed.tick === this.tick) {
      ed.arrivals += n;
      ed.surgeArrivals += n;
    }
    for (const unit of UNITS) {
      const row = this.history[unit].at(-1);
      if (!row || row.tick !== this.tick) continue;
      row.inUse = this.occupied(unit);
      row.queueLength = this.units[unit].queue.length;
    }
  }

  /**
   * 6h-ahead projection: in use now, minus already-scheduled discharges each hour, plus
   * the average net inflow per hour so far: arrivals plus patients moved in from other
   * units, minus patients moved out (to another unit or hospital). Before there is
   * history it uses the configured arrival mean. Patients waiting in a queue leave by
   * transfer (counted in the net inflow), not by their scheduled discharge.
   */
  projection(unit, hours = 6) {
    const hist = this.history[unit];
    // The emergency is a one-off, so it's left out of the usual arrival rate.
    const avgInflow = hist.length
      ? hist.reduce(
          (sum, h) => sum + h.arrivals - (h.surgeArrivals ?? 0) + (h.transfersIn ?? 0) - (h.transfersOut ?? 0),
          0,
        ) / hist.length
      : sim.ARRIVAL_MEANS[unit];
    const waiting = new Set(Object.values(this.units).flatMap((u) => u.queue.map((q) => q.patientId)));
    const schedule = new Map();
    for (const p of this.unitPatients(unit)) {
      if (waiting.has(p.id)) continue;
      const t = p.expectedDischargeTick;
      if (this.tick < t && t <= this.tick + hours) schedule.set(t, (schedule.get(t) ?? 0) + 1);
    }
    const staffed = this.units[unit].bedsStaffed;
    let projected = this.occupied(unit);
    const rows = [];
    for (let h = 1; h <= hours; h++) {
      const t = this.tick + h;
      projected = Math.max(0, Math.min(staffed, projected - (schedule.get(t) ?? 0) + avgInflow));
      rows.push({ tick: t, time: this.clock.time(t), projectedInUse: Math.round(projected) });
    }
    return rows;
  }

  // -- applying an approved plan ---------------------------------------------------------
  /** Apply one approved action; returns false when it no longer applies and was skipped. */
  applyAction(unit, action) {
    const patient = action.patientId ? this.patients.get(action.patientId) : undefined;
    switch (action.type) {
      case "accept_transfer": {
        const queued = this.units[unit].queue.find((q) => q.patientId === action.patientId);
        if (!patient || !queued) {
          this.addLog("Simulation", "info", `${action.patientId} could not move into ${unit}: no longer waiting`);
          return false;
        }
        this.countTransfer(unit, "transfersIn");
        this.countTransfer(queued.from, "transfersOut");
        this.movePatient(patient, unit);
        patient.admitTick = this.tick;
        patient.expectedDischargeTick = this.tick + sim.sampleLos(this.rng, unit);
        this.dequeue(patient.id);
        return true;
      }
      case "expedite_discharge":
        if (!patient || action.targetTick == null) return false;
        patient.expectedDischargeTick = action.targetTick;
        return true;
      case "open_overflow":
        this.units[unit].bedsStaffed += action.beds ?? 0;
        return true;
      case "request_beds":
        this.pendingRequests.push({ unit, beds: action.beds ?? 1, urgency: action.urgency ?? "normal", tick: this.tick });
        this.pendingRequests = this.pendingRequests.slice(-10);
        return true;
      case "divert_to": {
        if (!patient) {
          this.addLog("Simulation", "info", `${action.patientId} could not be sent to ${action.hospital}: no longer in the hospital`);
          return false;
        }
        // The patient physically leaves for the receiving hospital and takes a bed there.
        const targetUnit = patient.acuity >= 4 ? "ICU" : "Ward";
        this.countTransfer(patient.unit, "transfersOut");
        this.removePatient(patient.id);
        const receiving = this.neighbours[action.hospital]?.[targetUnit];
        if (receiving) receiving.bedsOccupied = Math.min(receiving.bedsStaffed, receiving.bedsOccupied + 1);
        return true;
      }
      case "divert_ed":
        this.edDivertTicksRemaining = sim.ED_DIVERT_TICKS;
        this.addLog("Simulation", "info", `Ambulances are diverted away from the ED for the next ${sim.ED_DIVERT_TICKS} hours.`);
        return true;
      default:
        // defer_transfer, defer_elective: recorded in the plan only
        return true;
    }
  }

  /** Apply every action of an approved plan; returns the actions that actually applied. */
  applyBundle(bundle) {
    const applied = [];
    for (const p of bundle.proposals) {
      for (const a of p.actions) {
        if (this.applyAction(p.unit, a)) applied.push({ proposal: p, action: a });
      }
    }
    this.fillBeds();
    return applied;
  }
}

function queueEntry(patient, waitingTicks) {
  return {
    patientId: patient.id,
    from: "ED",
    acuity: patient.acuity,
    condition: patient.condition,
    waitingTicks,
  };
}
