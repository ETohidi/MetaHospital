// The Twin: the one object views talk to. It owns the state and the seeded rng, runs
// the hourly loop (simulate -> plan -> safety check -> wait for the charge nurse), and
// hands out JSON-safe copies so views can't change the simulation by accident.

import { UNITS } from "../data/places.js";
import { DEFAULT_START_MS, TIME_ZONE_LABEL } from "./clock.js";
import * as coordinator from "./coordinator.js";
import * as family from "./family.js";
import * as planners from "./planners.js";
import * as regional from "./regional.js";
import { createRng } from "./rng.js";
import * as sim from "./sim.js";
import { HOSPITAL_NAMES, idNumber, TwinState } from "./state.js";

export const DEFAULT_SEED = 20260926;
/** Hours replayed before the first plan; the first plan is made one hour after that. */
export const DEFAULT_WARMUP_HOURS = 3;

const copy = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

function checkUnit(unit) {
  if (!UNITS.includes(unit)) throw new Error(`Unknown unit ${unit}`);
}

function checkHospital(name) {
  if (!HOSPITAL_NAMES.includes(name)) throw new Error(`Unknown hospital ${name}`);
}

export class Twin {
  #options;
  #listeners = new Set();

  /**
   * startMs is the moment of tick 0 (epoch ms, on the hour); every time label is German time.
   * The site passes "now" so the twin's current hour is the current hour in Germany; tests
   * keep the fixed default. The start only moves the labels: a seed replays the same day.
   */
  constructor({ seed = DEFAULT_SEED, warmupHours = DEFAULT_WARMUP_HOURS, firstPlan = true, startMs = DEFAULT_START_MS } = {}) {
    this.#options = { warmupHours, firstPlan };
    this.#init(seed, startMs);
  }

  #init(seed, startMs) {
    this.seed = seed;
    this.startMs = startMs;
    this.rng = createRng(seed);
    /** Internal; exposed for tests. Views use snapshot() and the query methods. */
    this.state = new TwinState({ seed, rng: this.rng, startMs });
    const { warmupHours, firstPlan } = this.#options;
    const patients = this.state.patients.size;
    this.#warmUp(warmupHours);
    const replayed = warmupHours
      ? ` The first ${warmupHours === 1 ? "hour was" : `${warmupHours} hours were`} replayed with every plan approved.`
      : "";
    this.state.log.unshift({
      tick: 0,
      time: this.state.clock.time(0),
      actor: "Simulation",
      text: `Started at ${this.state.clock.time(0)} ${TIME_ZONE_LABEL} with ${patients} patients.${replayed}`,
      level: "info",
    });
    if (firstPlan) this.#tick();
  }

  /**
   * Replay the first hours as if every plan had been approved (patients move upstairs,
   * beds fill realistically), then keep only the resulting state and history - not the
   * plans, log lines or family messages of those hours.
   */
  #warmUp(hours) {
    const state = this.state;
    for (let i = 0; i < hours; i++) state.applyBundle(this.#tick());
    state.bundles = [];
    state.nextBundleId = 1;
    state.log = [];
    state.familyMessages = [];
    state.recentTransfers = [];
    // A diversion approved during the replay would carry into the first plan with no log
    // line explaining it, so the visible day starts without one.
    state.edDivertTicksRemaining = 0;
  }

  // -- subscriptions ---------------------------------------------------------------
  subscribe(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #notify() {
    for (const fn of [...this.#listeners]) fn();
  }

  // -- commands ----------------------------------------------------------------------
  #tick() {
    const state = this.state;
    sim.step(state);
    const proposals = UNITS.map((u) => planners.generate(u, state));
    const capacity = Object.fromEntries(HOSPITAL_NAMES.map((name) => [name, regional.generate(name, state)]));
    state.recentProposals = proposals.map((p) => p.unit);
    return coordinator.buildBundle(state, proposals, capacity);
  }

  /** Advance one hour and make the next plan. Returns the new plan. */
  tick() {
    const bundle = this.#tick();
    this.#notify();
    return copy(bundle);
  }

  /** The bus accident: 20 casualties arrive at the ED now. */
  surge() {
    sim.injectSurge(this.state);
    this.#notify();
    return { surge: this.state.surgeMessage };
  }

  /** The charge nurse approves or rejects a pending plan. Returns the updated plan. */
  decide(bundleId, decision, reason) {
    const state = this.state;
    const bundle = state.bundles.find((b) => b.id === bundleId);
    if (!bundle) throw new Error("Plan not found");
    if (bundle.status !== "pending") throw new Error("Plan already decided");
    if (decision !== "approve" && decision !== "reject") throw new Error(`Unknown decision ${decision}`);

    const planTime = bundle.hourRange;
    bundle.decidedTime = state.time();
    if (decision === "approve") {
      const applied = state.applyBundle(bundle);
      const appliedActions = new Set(applied.map((x) => x.action));
      bundle.status = "approved";
      state.recentTransfers = applied
        .filter((x) => x.action.type === "accept_transfer")
        .map((x) => ({ from: x.action.from ?? "ED", to: x.proposal.unit, patientId: x.action.patientId }));
      for (const message of family.generateMessages(bundle, (a) => appliedActions.has(a), (t) => state.clock.time(t))) {
        state.addFamilyMessage(message);
      }
      state.addLog("Charge nurse", "decision", `approved the ${planTime} plan`);
    } else {
      bundle.status = "rejected";
      bundle.reason = reason ?? null;
      // Only the units that asked for something hear about it - including asks the safety
      // check already blocked, since the charge nurse saw those on the plan too.
      const asked = [...new Set(bundle.safety.map((e) => e.unit))];
      for (const unit of asked.length ? asked : UNITS) {
        state.addRejection(unit, reason || "rejected");
      }
      state.addLog("Charge nurse", "decision", `rejected the ${planTime} plan: ${reason || "no reason given"}`);
    }
    this.#notify();
    return copy(bundle);
  }

  /** Restart the day (same seed unless given). */
  reset({ seed, startMs } = {}) {
    this.#init(seed ?? this.seed, startMs ?? this.startMs);
    this.#notify();
  }

  // -- queries (all return copies) ---------------------------------------------------------
  snapshot() {
    const s = this.state;
    const units = Object.fromEntries(
      UNITS.map((u) => {
        const unit = s.units[u];
        return [
          u,
          {
            name: u,
            bedsTotal: unit.bedsTotal,
            bedsStaffed: unit.bedsStaffed,
            bedsOccupied: s.occupied(u),
            queue: unit.queue,
            recentRejections: s.activeRejections(u),
          },
        ];
      }),
    );
    const patients = [...s.patients.values()]
      .sort((a, b) => idNumber(a.id) - idNumber(b.id))
      .map((p) => ({ ...p, expectedDischargeTime: s.clock.time(p.expectedDischargeTick) }));
    return copy({
      tick: s.tick,
      time: s.time(),
      dayTime: s.dayTime(),
      hourRange: s.clock.hourRange(s.tick),
      date: s.clock.date(s.tick),
      startMs: this.startMs,
      timeZoneLabel: TIME_ZONE_LABEL,
      seed: this.seed,
      units,
      patients,
      surge: s.surgeMessage,
      surgeTicksRemaining: s.surgeTicksRemaining,
      edDivertHoursRemaining: s.edDivertTicksRemaining,
      pendingRequests: s.pendingRequests,
      hospitals: s.hospitalsSummary(),
      nearbyCapacity: s.nearbyCapacity,
      recentTransfers: s.recentTransfers,
      recentDischarges: s.recentDischarges,
      recentProposals: s.recentProposals,
      pendingBundle: s.bundles.find((b) => b.status === "pending") ?? null,
      bundleCount: s.bundles.length,
    });
  }

  census(unit) {
    checkUnit(unit);
    return copy(this.state.census(unit));
  }

  hospitalCensus(hospitalName) {
    checkHospital(hospitalName);
    return copy(this.state.hospitalCensus(hospitalName));
  }

  unitHistory(unit) {
    checkUnit(unit);
    return copy({ history: this.state.history[unit], projection: this.state.projection(unit) });
  }

  /** The unit's planner's latest plans, newest first. */
  unitPlans(unit, limit = 3) {
    checkUnit(unit);
    const matches = [];
    for (const b of [...this.state.bundles].reverse()) {
      const proposal = b.proposals.find((p) => p.unit === unit);
      if (!proposal) continue;
      matches.push({ bundleId: b.id, hourRange: b.hourRange, status: b.status, confidence: proposal.confidence });
      if (matches.length >= limit) break;
    }
    return matches;
  }

  hospitalHistory(hospitalName) {
    checkHospital(hospitalName);
    return copy(this.state.hospitalHistory[hospitalName]);
  }

  /** The hospital's latest capacity answers, newest first. */
  hospitalReports(hospitalName, limit = 3) {
    checkHospital(hospitalName);
    const matches = [];
    for (const b of [...this.state.bundles].reverse()) {
      const report = b.nearbyCapacity.find((r) => r.hospital === hospitalName);
      if (!report) continue;
      matches.push({
        hourRange: b.hourRange,
        canAccept: { ...report.canAccept },
        confidence: report.confidence,
        note: report.note ?? "",
      });
      if (matches.length >= limit) break;
    }
    return matches;
  }

  inbox() {
    return copy(this.state.bundles.filter((b) => b.status === "pending"));
  }

  bundles() {
    return copy([...this.state.bundles].reverse());
  }

  log() {
    return copy([...this.state.log].reverse());
  }

  family() {
    return copy([...this.state.familyMessages].reverse());
  }
}
