import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SEED, Twin } from "../src/engine/twin.js";
import * as coordinator from "../src/engine/coordinator.js";
import * as planners from "../src/engine/planners.js";
import * as regional from "../src/engine/regional.js";
import * as sim from "../src/engine/sim.js";
import { HOSPITAL_NAMES, REJECTION_MEMORY_TICKS } from "../src/engine/state.js";
import { RULE_DIVERT_ED } from "../src/engine/safety.js";
import { dayClock } from "../src/engine/clock.js";

const UNITS = ["ED", "ICU", "Ward"];
const OWN = "Klinikum Kreuzberg";
const SPREE = "Spreebogen Klinik";
const RIX = "Rixdorf Hospital";

// -- fixtures ------------------------------------------------------------------------------
/** A twin with no patients, no plan and nothing in progress, for scenarios set up by hand. */
function blankTwin() {
  const t = new Twin({ firstPlan: false });
  const s = t.state;
  s.patients.clear();
  for (const u of Object.values(s.units)) {
    u.queue = [];
    u.rejections = [];
  }
  s.pendingRequests = [];
  s.surgeMessage = null;
  s.surgeTicksRemaining = 0;
  s.edDivertTicksRemaining = 0;
  return t;
}

/** One planning round with the real planners, exactly as Twin.tick() does it, minus the simulation step. */
function planWithRealPlanners(t) {
  const s = t.state;
  const proposals = UNITS.map((u) => planners.generate(u, s));
  const capacity = Object.fromEntries(HOSPITAL_NAMES.map((name) => [name, regional.generate(name, s)]));
  return coordinator.buildBundle(s, proposals, capacity);
}

function fill(s, unit, n, extra = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(
      s.addPatient({ unit, acuity: 2, condition: "other", admitTick: s.tick - 5, expectedDischargeTick: s.tick + 50, ...extra }),
    );
  }
  return out;
}

function waitFor(s, unit, { acuity, waitingTicks = 1, condition = "other" }) {
  const [p] = fill(s, "ED", 1, { acuity, condition });
  s.units[unit].queue.push({ patientId: p.id, from: "ED", acuity, condition, waitingTicks });
  return p;
}

function cap(hospital, icu, ward, confidence = 0.85) {
  return { hospital, canAccept: { ICU: icu, Ward: ward }, validUntil: "12:00", conditionsPreferred: [], confidence, note: "" };
}

const CAPS = Object.fromEntries([cap(OWN, 0, 0), cap(SPREE, 2, 2), cap(RIX, 2, 2)].map((c) => [c.hospital, c]));

const prop = (unit, actions, confidence = 0.8) => ({
  unit,
  author: `${unit} planner`,
  actions,
  rationale: "test",
  confidence,
  risks: [],
});

/** Build a plan from hand-made proposals (ED, ICU, Ward order; missing units propose nothing). */
function planFrom(t, byUnit, capacity = CAPS) {
  const proposals = UNITS.map((u) => prop(u, byUnit[u] ?? []));
  return coordinator.buildBundle(t.state, proposals, capacity);
}

function checkInvariants(t, label) {
  const mutable = t.snapshot();
  const snap = t.snapshot();
  const ctx = `${label} (tick ${snap.tick})`;

  // JSON-safe, and a copy: changing one snapshot changes neither the twin nor the next snapshot.
  assert.deepEqual(JSON.parse(JSON.stringify(mutable)), mutable, `${ctx}: snapshot is JSON-safe`);
  mutable.patients.forEach((p) => (p.bed = -1));
  mutable.units.ICU.queue.push({ patientId: "x", waitingTicks: -1 });
  mutable.hospitals[1].units.Ward.bedsOccupied = -99;
  if (mutable.pendingBundle) mutable.pendingBundle.rows.length = 0;
  assert.deepEqual(t.snapshot(), snap, `${ctx}: snapshot is copy-isolated`);

  const byId = new Map(snap.patients.map((p) => [p.id, p]));
  assert.equal(byId.size, snap.patients.length, `${ctx}: patient ids unique`);
  const queuedIn = new Map(); // patientId -> queue item

  for (const u of UNITS) {
    const unit = snap.units[u];
    const inUnit = snap.patients.filter((p) => p.unit === u);
    assert.ok(unit.bedsOccupied >= 0 && unit.bedsStaffed >= 0 && unit.bedsTotal >= 0, `${ctx}: ${u} counts non-negative`);
    assert.equal(unit.bedsOccupied, inUnit.length, `${ctx}: ${u} occupancy`);
    const beds = inUnit.filter((p) => p.bed !== null).map((p) => p.bed);
    assert.equal(new Set(beds).size, beds.length, `${ctx}: ${u} bed numbers unique`);
    assert.ok(beds.length <= unit.bedsStaffed, `${ctx}: ${u} more beds in use than staffed`);
    for (const bed of beds) assert.ok(Number.isInteger(bed) && bed >= 1 && bed <= unit.bedsStaffed, `${ctx}: ${u} bed ${bed}`);
    if (inUnit.some((p) => p.bed === null)) {
      assert.equal(beds.length, unit.bedsStaffed, `${ctx}: ${u} has a bedless patient while beds are free`);
    }
    for (const q of unit.queue) {
      const patient = byId.get(q.patientId);
      assert.ok(patient, `${ctx}: ${u} queue references missing ${q.patientId}`);
      assert.equal(patient.unit, q.from, `${ctx}: ${q.patientId} is queued from ${q.from} but is in ${patient.unit}`);
      assert.ok(!queuedIn.has(q.patientId), `${ctx}: ${q.patientId} waits in two queues`);
      assert.ok(q.waitingTicks >= 0 && q.waitingTicks <= sim.MAX_BOARDING_TICKS, `${ctx}: ${q.patientId} waited ${q.waitingTicks}h`);
      queuedIn.set(q.patientId, q);
    }
    assert.ok(unit.recentRejections.length <= 5);
  }
  // Only a patient boarding in a queue may be past their expected discharge.
  for (const p of snap.patients) {
    if (p.expectedDischargeTick > snap.tick) continue;
    const q = queuedIn.get(p.id);
    assert.ok(q, `${ctx}: ${p.id} overdue without waiting for a bed`);
    assert.ok(q.waitingTicks <= sim.MAX_BOARDING_TICKS, `${ctx}: ${p.id} boarded too long`);
  }

  assert.equal(snap.hospitals[0].name, OWN);
  assert.equal(snap.hospitals[0].isOwn, true);
  for (const h of snap.hospitals) {
    for (const u of UNITS) {
      const beds = h.units[u];
      assert.ok(beds.bedsOccupied >= 0, `${ctx}: ${h.name} ${u} negative`);
      if (!h.isOwn) assert.ok(beds.bedsOccupied <= beds.bedsStaffed, `${ctx}: ${h.name} ${u} over staffed`);
    }
    for (const row of t.hospitalHistory(h.name)) {
      for (const u of UNITS) assert.ok(row.freeBeds[u] >= 0, `${ctx}: ${h.name} history freeBeds ${u} negative`);
    }
  }
  for (const u of UNITS) {
    for (const row of t.unitHistory(u).history) {
      for (const k of ["inUse", "usable", "arrivals", "surgeArrivals", "discharges", "transfersIn", "transfersOut", "queueLength"]) {
        assert.ok(row[k] >= 0, `${ctx}: ${u} history ${k} negative at tick ${row.tick}`);
      }
    }
  }
  assert.ok(snap.surgeTicksRemaining >= 0 && snap.edDivertHoursRemaining >= 0);
  assert.ok(t.inbox().length <= 1);
  return snap;
}

// -- construction ----------------------------------------------------------------------------
test("default twin: 12:00 with a pending 12:00–13:00 plan after 3 replayed hours", () => {
  const t = new Twin();
  const snap = t.snapshot();
  assert.equal(snap.tick, 4);
  assert.equal(snap.time, "12:00");
  assert.equal(snap.dayTime, "Wednesday 12:00");
  assert.equal(snap.hourRange, "12:00–13:00");
  assert.equal(DEFAULT_SEED, 20260926);
  assert.equal(snap.seed, DEFAULT_SEED);
  assert.ok(snap.pendingBundle);
  assert.equal(snap.pendingBundle.id, 1);
  assert.equal(snap.pendingBundle.hourRange, "12:00–13:00");
  assert.equal(snap.bundleCount, 1);
  assert.deepEqual(snap.hospitals.map((h) => h.id), ["kreuzberg", "spreebogen", "rixdorf"]);
  assert.equal(snap.hospitals[0].units.ICU.bedsTotal, 20);
  assert.equal(snap.edDivertHoursRemaining, 0);
  assert.equal(t.unitHistory("ED").history.length, 5); // ticks 0..4

  const oldest = t.log().at(-1);
  assert.equal(oldest.actor, "Simulation");
  assert.equal(oldest.time, "08:00");
  assert.equal(oldest.tick, 0);
  assert.equal(oldest.level, "info");
  assert.equal(
    oldest.text,
    "Day started at 08:00 with 107 patients. The first 3 hours were replayed with every plan approved.",
  );
  assert.ok(t.log().every((l) => l.actor !== "Hospital" && !l.actor.endsWith(" agent")));
  checkInvariants(t, "default");
});

test("constructor options: no warmup and no first plan", () => {
  const t = new Twin({ warmupHours: 0, firstPlan: false });
  const snap = t.snapshot();
  assert.equal(snap.time, "08:00");
  assert.equal(snap.pendingBundle, null);
  assert.equal(snap.patients.length, 107);
  assert.deepEqual(t.log().map((l) => l.text), ["Day started at 08:00 with 107 patients."]);
});

test("constructor options: one warmup hour is worded in the singular", () => {
  const t = new Twin({ warmupHours: 1 });
  assert.equal(t.snapshot().time, "10:00");
  assert.equal(
    t.log().at(-1).text,
    "Day started at 08:00 with 107 patients. The first hour was replayed with every plan approved.",
  );
  assert.equal(t.inbox()[0].id, 1);
});

// -- warmup ---------------------------------------------------------------------------------------
test("warmup: the replayed hours approve every plan, then keep only the resulting state", () => {
  const t = new Twin();
  // No plans, log lines, family messages or transfers from the replayed hours 09:00-11:00.
  assert.deepEqual(t.bundles().map((b) => [b.id, b.status]), [[1, "pending"]]);
  assert.deepEqual(t.log().filter((l) => l.tick > 0 && l.tick < 4), []);
  assert.deepEqual(t.log().filter((l) => l.tick === 0).map((l) => l.actor), ["Simulation"]);
  assert.deepEqual(t.family(), []);
  assert.deepEqual(t.snapshot().recentTransfers, []);
  assert.equal(t.state.nextBundleId, 2);

  // Every plan was applied, so nobody is left waiting from the replayed hours: the only
  // patients in the queues arrived this hour, and the first plan has beds for all of them.
  const snap = t.snapshot();
  for (const u of ["ICU", "Ward"]) {
    const queue = snap.units[u].queue;
    assert.ok(queue.length <= 5, `${u} queue has ${queue.length} patients`);
    assert.deepEqual(queue.map((q) => q.waitingTicks), queue.map(() => 1), `${u}: nobody waited through the warmup`);
    const taken = snap.pendingBundle.rows.filter((r) => r.unit === u && r.actionType === "accept_transfer").map((r) => r.patientId);
    assert.deepEqual(taken.sort(), queue.map((q) => q.patientId).sort());
  }
});

test("warmup: approving the replayed plans leaves far shorter queues than not approving them", () => {
  let approved = 0;
  let unapproved = 0;
  for (let seed = 1; seed <= 5; seed++) {
    const a = new Twin({ seed, firstPlan: false });
    const b = new Twin({ seed, warmupHours: 0, firstPlan: false });
    for (let i = 0; i < 3; i++) sim.step(b.state); // the same 3 hours, nobody approving anything
    assert.equal(a.state.tick, b.state.tick);
    for (const u of ["ICU", "Ward"]) {
      approved += a.state.units[u].queue.length;
      unapproved += b.state.units[u].queue.length;
    }
  }
  assert.ok(unapproved >= 20, `unapproved warmup leaves ${unapproved} waiting`);
  assert.ok(approved * 4 <= unapproved, `approved ${approved} vs unapproved ${unapproved}`);
});

// -- determinism --------------------------------------------------------------------------------
function script(seed) {
  const t = new Twin({ seed });
  for (let i = 0; i < 30; i++) {
    if (i === 3 || i === 17) t.surge();
    const pending = t.inbox()[0];
    if (pending && i % 3 === 0) t.decide(pending.id, "approve");
    else if (pending && i % 7 === 1) t.decide(pending.id, "reject", "A nearby hospital should take this patient");
    t.tick();
  }
  return t;
}

test("same seed and commands give identical twins; different seeds differ", () => {
  const a = script(11);
  const b = script(11);
  const c = script(12);
  assert.deepEqual(a.snapshot(), b.snapshot());
  assert.deepEqual(a.log(), b.log());
  assert.deepEqual(a.bundles(), b.bundles());
  assert.deepEqual(a.family(), b.family());
  assert.notDeepEqual(a.snapshot().patients, c.snapshot().patients);
});

test("read-only queries do not change the simulation", () => {
  const a = new Twin({ seed: 3 });
  const b = new Twin({ seed: 3 });
  for (let i = 0; i < 5; i++) {
    for (const name of [OWN, SPREE, RIX]) {
      a.hospitalCensus(name);
      a.hospitalReports(name);
      a.hospitalHistory(name);
    }
    for (const u of UNITS) {
      a.census(u);
      a.unitHistory(u);
      a.unitPlans(u);
    }
    a.snapshot();
    a.tick();
    b.tick();
  }
  assert.deepEqual(a.snapshot(), b.snapshot());
});

// -- invariants -------------------------------------------------------------------------------------
test("invariants hold over 72 hours with surges, approving every plan", () => {
  const t = new Twin({ seed: 99 });
  checkInvariants(t, "start");
  for (let i = 0; i < 72; i++) {
    if (i === 2 || i === 20 || i === 21 || i === 50) {
      t.surge();
      checkInvariants(t, `surge ${i}`);
    }
    const pending = t.inbox()[0];
    if (pending) {
      t.decide(pending.id, "approve");
      checkInvariants(t, `approve ${i}`);
    }
    t.tick();
    checkInvariants(t, `tick ${i}`);
  }
  assert.equal(t.snapshot().dayTime, "Saturday 12:00"); // 76 ticks after Wednesday 08:00
});

test("ICU and Ward planners never ask for more transfers than they have free beds (72 hours, 3 seeds)", () => {
  for (const seed of [99, 7, DEFAULT_SEED]) {
    const t = new Twin({ seed });
    const staffed = { ICU: t.state.units.ICU.bedsStaffed, Ward: t.state.units.Ward.bedsStaffed };
    for (let i = 0; i < 72; i++) {
      if (i === 2 || i === 30) t.surge();
      const pending = t.inbox()[0];
      if (pending && i % 5 !== 4) t.decide(pending.id, "approve");
      t.tick();
    }
    let accepts = 0;
    for (const b of t.bundles()) {
      for (const u of ["ICU", "Ward"]) {
        const asks = b.safety.filter((e) => e.author === `${u} planner` && e.action.type === "accept_transfer");
        accepts += asks.length;
        const free = Math.max(0, staffed[u] - b.before[u]);
        assert.ok(asks.length <= free, `seed ${seed}, ${b.hourRange}: ${u} asked for ${asks.length} with ${free} free`);
        assert.ok(asks.every((e) => !e.blocked), `seed ${seed}, ${b.hourRange}: a ${u} transfer was blocked`);
      }
    }
    assert.ok(accepts > 50, `seed ${seed}: only ${accepts} transfers asked for`);
  }
});

test("snapshot and query results are copies", () => {
  const t = new Twin();
  const snap = t.snapshot();
  snap.units.ED.queue.push({ patientId: "x" });
  snap.patients[0].bed = 999;
  snap.pendingBundle.status = "approved";
  snap.hospitals[1].units.ICU.bedsOccupied = -5;
  snap.nearbyCapacity[RIX].canAccept.ICU = 99;
  t.census("ICU").queue.push({ patientId: "y" });
  t.inbox()[0].proposals.length = 0;
  t.log()[0].text = "changed";
  t.unitHistory("ED").history.length = 0;
  const fresh = t.snapshot();
  assert.notEqual(fresh.patients[0].bed, 999);
  assert.equal(fresh.pendingBundle.status, "pending");
  assert.ok(fresh.hospitals[1].units.ICU.bedsOccupied >= 0);
  assert.notEqual(fresh.nearbyCapacity[RIX].canAccept.ICU, 99);
  assert.ok(!fresh.units.ED.queue.some((q) => q.patientId === "x"));
  assert.ok(!t.census("ICU").queue.some((q) => q.patientId === "y"));
  assert.ok(t.inbox()[0].proposals.length > 0);
  assert.notEqual(t.log()[0].text, "changed");
  assert.ok(t.unitHistory("ED").history.length > 0);
});

// -- commands and subscriptions --------------------------------------------------------------------------
test("every command notifies each listener exactly once; unsubscribe stops it", () => {
  const t = new Twin();
  let calls = 0;
  const unsubscribe = t.subscribe(() => (calls += 1));
  t.tick();
  assert.equal(calls, 1);
  assert.deepEqual(t.surge(), { surge: "bus accident, 20 casualties" });
  assert.equal(calls, 2);
  t.decide(t.inbox()[0].id, "approve");
  assert.equal(calls, 3);
  t.reset();
  assert.equal(calls, 4);
  assert.throws(() => t.decide(999, "approve"));
  assert.equal(calls, 4, "a failed command does not notify");
  unsubscribe();
  t.tick();
  assert.equal(calls, 4);
});

test("reset replays the same day; reset with a seed matches a fresh twin with that seed", () => {
  const t = new Twin();
  const fresh = new Twin().snapshot();
  t.surge();
  t.tick();
  t.tick();
  t.reset();
  assert.deepEqual(t.snapshot(), fresh);
  assert.deepEqual(t.log(), new Twin().log());
  t.reset({ seed: 5 });
  assert.deepEqual(t.snapshot(), new Twin({ seed: 5 }).snapshot());
  t.reset();
  assert.equal(t.snapshot().seed, 5);
});

test("unknown units and hospitals throw", () => {
  const t = new Twin();
  assert.throws(() => t.census("OR"), /Unknown unit/);
  assert.throws(() => t.unitHistory("icu"), /Unknown unit/);
  assert.throws(() => t.unitPlans("Lab"), /Unknown unit/);
  assert.throws(() => t.hospitalCensus("Nowhere Klinik"), /Unknown hospital/);
  assert.throws(() => t.hospitalHistory("rixdorf"), /Unknown hospital/);
  assert.throws(() => t.hospitalReports("Nowhere"), /Unknown hospital/);
});

test("tick returns the new plan; bundles and log are newest first", () => {
  const t = new Twin();
  const b = t.tick();
  assert.equal(b.id, 2);
  assert.equal(b.hourRange, "13:00–14:00");
  assert.deepEqual(t.bundles().map((x) => x.id), [2, 1]);
  assert.equal(t.log()[0].text, b.summary);
  assert.deepEqual(t.inbox().map((x) => x.id), [2]);
  assert.deepEqual(t.unitPlans("ED").map((p) => p.bundleId), [2, 1]);
  assert.deepEqual(Object.keys(t.unitPlans("ED")[0]), ["bundleId", "hourRange", "status", "confidence"]);
  const reports = t.hospitalReports(RIX);
  assert.equal(reports.length, 2);
  assert.equal(reports[0].hourRange, "13:00–14:00");
  assert.deepEqual(Object.keys(reports[0]), ["hourRange", "canAccept", "confidence", "note"]);
  const hist = t.hospitalHistory(RIX);
  assert.equal(hist.length, 6);
  assert.deepEqual(Object.keys(hist[0].freeBeds), UNITS);
  const { history, projection } = t.unitHistory("Ward");
  assert.equal(history.at(-1).tick, 5);
  assert.equal(projection.length, 6);
  assert.equal(projection[0].time, "14:00");
  const hc = t.hospitalCensus(SPREE);
  assert.equal(hc.hospital, SPREE);
  assert.deepEqual(Object.keys(hc.expectedDischarges3h), ["ICU", "Ward"]);
});

test("history: unit and hospital history keep the latest 168 hourly rows (a week)", () => {
  const t = new Twin({ seed: 5, firstPlan: false });
  for (let i = 0; i < 170; i++) t.tick(); // 3 warmup hours + 170 = 174 rows recorded
  const now = t.snapshot().tick;
  assert.equal(now, 173);
  for (const u of UNITS) {
    const rows = t.unitHistory(u).history;
    assert.equal(rows.length, 168, u);
    assert.equal(rows.at(-1).tick, now);
    assert.equal(rows[0].tick, now - 167);
    assert.deepEqual(Object.keys(rows[0]), [
      "tick",
      "time",
      "dayTime",
      "inUse",
      "usable",
      "arrivals",
      "surgeArrivals",
      "discharges",
      "transfersIn",
      "transfersOut",
      "queueLength",
    ]);
    assert.equal(rows.at(-1).dayTime, dayClock(now));
  }
  for (const name of [OWN, SPREE, RIX]) {
    const rows = t.hospitalHistory(name);
    assert.equal(rows.length, 168, name);
    assert.equal(rows.at(-1).tick, now);
    assert.equal(rows[0].tick, now - 167);
    assert.deepEqual(Object.keys(rows[0]), ["tick", "time", "dayTime", "freeBeds"]);
    assert.equal(rows.at(-1).dayTime, dayClock(now)); // a week of rows repeats times, so charts need the day
  }
});

// -- plan expiry and decide errors ----------------------------------------------------------------------
test("a plan left waiting expires when the next one is made", () => {
  const t = new Twin();
  const first = t.inbox()[0];
  t.tick();
  const expired = t.bundles().find((b) => b.id === first.id);
  assert.equal(expired.status, "expired");
  assert.equal(expired.decidedTime, "13:00");
  assert.deepEqual(t.inbox().map((b) => b.id), [first.id + 1]);
  assert.ok(t.log().some((l) => l.actor === "Coordinator" && l.text === "12:00–13:00 plan expired without a decision"));
  assert.throws(() => t.decide(first.id, "approve"), { message: "Plan already decided" });
});

test("decide: unknown plan, already decided, and decision fields", () => {
  const t = new Twin();
  assert.throws(() => t.decide(42, "approve"), { message: "Plan not found" });
  const id = t.inbox()[0].id;
  const approved = t.decide(id, "approve");
  assert.equal(approved.status, "approved");
  assert.equal(approved.decidedTime, "12:00");
  assert.throws(() => t.decide(id, "approve"), { message: "Plan already decided" });
  assert.throws(() => t.decide(id, "reject", "x"), { message: "Plan already decided" });
  assert.equal(t.snapshot().pendingBundle, null);
  assert.equal(t.log()[0].text, "approved the 12:00–13:00 plan");
  assert.equal(t.log()[0].actor, "Charge nurse");

  const next = t.tick();
  const rejected = t.decide(next.id, "reject", "Wrong priority order");
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.reason, "Wrong priority order");
  assert.equal(t.log()[0].text, "rejected the 13:00–14:00 plan: Wrong priority order");
});

// -- rejections: routing and memory -------------------------------------------------------------------------
test("a rejection reaches only the units that asked for something, and fades after 4 hours", () => {
  const t = blankTwin();
  const s = t.state;
  fill(s, "ED", 10);
  const reason = "A nearby hospital should take this patient";
  const b = planFrom(t, { ED: [{ type: "request_beds", beds: 2, urgency: "high" }] });
  t.decide(b.id, "reject", reason);

  let snap = t.snapshot();
  assert.deepEqual(snap.units.ED.recentRejections, [reason]);
  assert.deepEqual(snap.units.ICU.recentRejections, []);
  assert.deepEqual(snap.units.Ward.recentRejections, []);
  assert.match(t.census("ED").hint, /nearby hospital could take this patient/);
  assert.equal(t.census("ICU").hint, null);

  s.tick += REJECTION_MEMORY_TICKS - 1;
  assert.deepEqual(t.census("ED").recentRejections, [reason]);
  s.tick += 1;
  assert.deepEqual(t.census("ED").recentRejections, []);
  assert.equal(t.census("ED").hint, null);
  assert.deepEqual(t.snapshot().units.ED.recentRejections, []);
});

test("rejecting a plan with no actions reaches every unit; no reason is stored as 'rejected'", () => {
  const t = blankTwin();
  const b = planFrom(t, {});
  t.decide(b.id, "reject");
  for (const u of UNITS) assert.deepEqual(t.snapshot().units[u].recentRejections, ["rejected"]);
  assert.equal(t.census("ED").hint, null);
});

test("hint appears only for reasons mentioning a nearby hospital (any case)", () => {
  const t = blankTwin();
  let b = planFrom(t, { Ward: [{ type: "defer_elective" }] });
  t.decide(b.id, "reject", "Wrong priority order");
  assert.equal(t.census("Ward").hint, null);
  b = planFrom(t, { Ward: [{ type: "defer_elective" }] });
  t.decide(b.id, "reject", "Try a NEARBY HOSPITAL first");
  assert.match(t.census("Ward").hint, /check Nearby capacity/);
});

test("a planner whose ask the safety check blocked still hears the rejection", () => {
  const t = blankTwin();
  const s = t.state;
  fill(s, "ED", 20); // 71% of 28
  s.edDivertTicksRemaining = 1; // an approved ambulance diversion is still running
  const b = planWithRealPlanners(t);
  const ask = b.safety.find((e) => e.unit === "ED");
  assert.equal(ask.action.type, "divert_ed");
  assert.equal(ask.blocked, true);
  assert.equal(ask.rule, RULE_DIVERT_ED);
  assert.deepEqual(b.proposals.find((p) => p.unit === "ED").actions, [], "nothing of ED's is left in the plan");
  assert.deepEqual(new Set(b.safety.map((e) => e.unit)), new Set(["ED"]));

  t.decide(b.id, "reject", "Wrong priority order");
  const snap = t.snapshot();
  assert.deepEqual(snap.units.ED.recentRejections, ["Wrong priority order"]);
  assert.deepEqual(snap.units.ICU.recentRejections, [], "ICU asked for nothing");
  assert.deepEqual(snap.units.Ward.recentRejections, [], "Ward asked for nothing");

  // ...and backs off: no second request to keep diverting while the rejection is remembered.
  s.tick += 1;
  const next = planners.generate("ED", s);
  assert.deepEqual(next.actions, []);
  assert.match(next.rationale, /\(Noting recent rejection: Wrong priority order\)$/);
});

test("the Regional coordinator's diverts count as ICU's ask when a plan is rejected", () => {
  const t = blankTwin();
  const s = t.state;
  fill(s, "ICU", 19); // full
  const p = waitFor(s, "ICU", { acuity: 5 });
  const b = planFrom(t, {});
  assert.equal(b.rows.length, 1);
  assert.equal(b.rows[0].author, "Regional coordinator");
  assert.equal(b.rows[0].patientId, p.id);
  t.decide(b.id, "reject", "A nearby hospital should take this patient");
  assert.deepEqual(t.snapshot().units.ICU.recentRejections, ["A nearby hospital should take this patient"]);
  assert.deepEqual(t.snapshot().units.ED.recentRejections, []);
  assert.match(t.census("ICU").hint, /nearby hospital could take this patient/);
});

test("ED's premature divert_ed comes back once the rejection has faded", () => {
  const t = blankTwin();
  const s = t.state;
  fill(s, "ED", 26); // 93% of 28: in the 90-95% band
  assert.equal(planners.generate("ED", s).actions[0].type, "divert_ed");

  const b = planFrom(t, { ED: [{ type: "divert_ed" }] });
  t.decide(b.id, "reject", "Wrong priority order");
  const cautious = planners.generate("ED", s);
  assert.equal(cautious.actions[0].type, "request_beds");
  assert.match(cautious.rationale, /\(Noting recent rejection: Wrong priority order\)$/);

  s.tick += REJECTION_MEMORY_TICKS;
  const again = planners.generate("ED", s);
  assert.equal(again.actions[0].type, "divert_ed");
  assert.ok(!again.rationale.includes("Noting recent rejection"));
});

// -- the ICU planner reads the hint -----------------------------------------------------------------------
test("the ICU planner reads the census hint", () => {
  const t = blankTwin();
  const s = t.state;
  fill(s, "ICU", 19);
  const before = planners.generate("ICU", s);
  assert.equal(before.rationale, "Nobody is waiting for an ICU bed.");

  const p = waitFor(s, "ICU", { acuity: 5 });
  const b = planFrom(t, { ICU: [{ type: "accept_transfer", patientId: p.id, from: "ED" }] });
  assert.equal(b.safety[0].blocked, true, "ICU is full");
  t.decide(b.id, "reject", "A nearby hospital should take this patient");
  const withHint = planners.generate("ICU", s);
  assert.ok(withHint.rationale.includes(planners.ICU_HINT_NOTE));
  assert.equal(
    planners.ICU_HINT_NOTE,
    "Charge nurse asked us to look at nearby hospitals; the Regional coordinator will offer receiving hospitals.",
  );
  assert.equal(
    withHint.rationale,
    `No free ICU beds; holding position. ${planners.ICU_HINT_NOTE} (Noting recent rejection: A nearby hospital should take this patient)`,
  );

  // The hint also rides along when ICU does take patients.
  s.removePatient(s.unitPatients("ICU")[0].id);
  const taking = planners.generate("ICU", s);
  assert.equal(taking.actions.length, 1);
  assert.match(taking.rationale, /^Taking 1 waiting patient, sickest first\. Charge nurse asked/);
});

// -- family messages --------------------------------------------------------------------------------------
test("approving a divert_to tells the family where the patient goes", () => {
  const t = blankTwin();
  const s = t.state;
  const p = fill(s, "ED", 1, { acuity: 4 })[0];
  const b = planFrom(t, { ICU: [{ type: "divert_to", patientId: p.id, hospital: RIX, confidence: 0.85 }] });
  t.decide(b.id, "approve");
  assert.equal(
    t.family()[0].text,
    `Patient ${p.id} is being transferred to ${RIX}, which has confirmed it can take them. Their records go with them.`,
  );
});

test("family confidence uses the action's own confidence, else the proposal's", () => {
  const t = blankTwin();
  const b = coordinator.buildBundle(
    t.state,
    [
      prop("ED", [], 0.6),
      prop("ICU", [{ type: "open_overflow", beds: 1, confidence: 0.9 }, { type: "open_overflow", beds: 1 }], 0.3),
      prop("Ward", [{ type: "request_beds", beds: 2, urgency: "low", confidence: 0.5 }], 0.3),
    ],
    CAPS,
  );
  t.decide(b.id, "approve");
  assert.deepEqual(
    t.family().map((m) => m.text).reverse(),
    [
      "ICU is opening 1 additional bed to handle demand. Confidence: high.",
      "ICU is opening 1 additional bed to handle demand. Confidence: low.",
      "Ward has requested additional bed capacity from other units. Confidence: medium.",
    ],
  );
});

// -- diverts to neighbouring hospitals --------------------------------------------------------------------
test("an approved divert_to moves the patient into the receiving hospital's bed count", () => {
  const t = blankTwin();
  const s = t.state;
  const icuPatient = waitFor(s, "ICU", { acuity: 5 });
  const wardPatient = fill(s, "ED", 1, { acuity: 3 })[0];
  // Room at Rixdorf, whatever the warmup hours did to its bed counts.
  s.neighbours[RIX].ICU.bedsOccupied = s.neighbours[RIX].ICU.bedsStaffed - 3;
  s.neighbours[RIX].Ward.bedsOccupied = s.neighbours[RIX].Ward.bedsStaffed - 3;
  const rixBefore = structuredClone(s.neighbours[RIX]);
  s.neighbours[SPREE].ICU.bedsOccupied = s.neighbours[SPREE].ICU.bedsStaffed; // full, but its answer still says 2
  const spreeFull = s.neighbours[SPREE].ICU.bedsOccupied;
  const third = fill(s, "ED", 1, { acuity: 4 })[0];

  const b = planFrom(t, {
    ICU: [
      { type: "divert_to", patientId: icuPatient.id, hospital: RIX },
      { type: "divert_to", patientId: wardPatient.id, hospital: RIX },
      { type: "divert_to", patientId: third.id, hospital: SPREE },
    ],
  });
  assert.ok(b.safety.every((e) => !e.blocked));
  t.decide(b.id, "approve");

  assert.ok(!s.patients.has(icuPatient.id) && !s.patients.has(wardPatient.id) && !s.patients.has(third.id));
  assert.equal(s.units.ICU.queue.length, 0);
  assert.equal(s.neighbours[RIX].ICU.bedsOccupied, rixBefore.ICU.bedsOccupied + 1);
  assert.equal(s.neighbours[RIX].Ward.bedsOccupied, rixBefore.Ward.bedsOccupied + 1);
  assert.equal(s.neighbours[SPREE].ICU.bedsOccupied, spreeFull, "capped at staffed beds");
  checkInvariants(t, "divert_to approval");
});

// -- ambulance diversion ----------------------------------------------------------------------------------
test("an approved divert_ed halves ED arrivals for the next 2 hours", () => {
  const t = blankTwin();
  const s = t.state;
  fill(s, "ED", 27);
  const means = [];
  const poisson = s.rng.poisson;
  s.rng.poisson = (mean) => {
    means.push(mean);
    return poisson(mean);
  };

  const b = planFrom(t, { ED: [{ type: "divert_ed", confidence: 0.85 }] });
  assert.equal(b.safety[0].blocked, false);
  t.decide(b.id, "approve");
  assert.equal(t.snapshot().edDivertHoursRemaining, 2);
  assert.equal(sim.arrivalMean(s, "ED"), sim.ARRIVAL_MEANS.ED / 2);
  assert.ok(t.family()[0].text.startsWith("The Emergency Department is temporarily diverting incoming ambulances."));

  const edMeans = () => means.filter((_, i) => i % 3 === 0); // ED is drawn first each step
  t.tick();
  assert.equal(t.snapshot().edDivertHoursRemaining, 1);
  t.tick();
  assert.equal(t.snapshot().edDivertHoursRemaining, 0);
  assert.ok(t.log().some((l) => l.text.startsWith("Ambulance diversion ended")));
  t.tick();
  const { ED, ICU, Ward } = sim.ARRIVAL_MEANS;
  assert.deepEqual(edMeans(), [ED / 2, ED / 2, ED]);
  assert.deepEqual(edMeans(), [3.5, 3.5, 7]);
  assert.deepEqual(means.filter((_, i) => i % 3 !== 0), [ICU, Ward, ICU, Ward, ICU, Ward]);
});

// -- stale approvals --------------------------------------------------------------------------------------
test("approval skips a transfer whose patient is gone or no longer waiting", () => {
  const t = blankTwin();
  const s = t.state;
  const gone = waitFor(s, "Ward", { acuity: 3 });
  const stillThere = waitFor(s, "ICU", { acuity: 4 });
  const b = planFrom(t, {
    ICU: [{ type: "accept_transfer", patientId: stillThere.id, from: "ED" }],
    Ward: [{ type: "accept_transfer", patientId: gone.id, from: "ED" }],
  });
  assert.equal(b.rows.length, 2);
  s.removePatient(gone.id); // discharged before the nurse decided
  s.units.Ward.queue.push({ patientId: stillThere.id, from: "ED", acuity: 4, condition: "other", waitingTicks: 0 });

  t.decide(b.id, "approve");
  assert.ok(t.log().some((l) => l.actor === "Simulation" && l.text === `${gone.id} could not move into Ward: no longer waiting`));
  assert.equal(s.patients.get(stillThere.id).unit, "ICU");
  assert.equal(s.units.ICU.queue.length, 0);
  assert.equal(s.units.Ward.queue.length, 0, "removed from every queue");
  assert.deepEqual(t.snapshot().recentTransfers, [{ from: "ED", to: "ICU", patientId: stillThere.id }]);
  assert.equal(t.family().length, 1, "no family message for the skipped transfer");
  assert.ok(t.family()[0].text.startsWith(`Patient ${stillThere.id} is moving from ED to ICU around`));
  checkInvariants(t, "stale approval");
});

test("approval skips a divert_to whose patient already left the hospital", () => {
  const t = blankTwin();
  const s = t.state;
  const p = fill(s, "ED", 1, { acuity: 4 })[0];
  const rixBefore = s.neighbours[RIX].ICU.bedsOccupied;
  const b = planFrom(t, { ICU: [{ type: "divert_to", patientId: p.id, hospital: RIX }] });
  assert.equal(b.safety[0].blocked, false);
  s.removePatient(p.id);
  t.decide(b.id, "approve");
  assert.ok(t.log().some((l) => l.actor === "Simulation" && l.text === `${p.id} could not be sent to ${RIX}: no longer in the hospital`));
  assert.equal(s.neighbours[RIX].ICU.bedsOccupied, rixBefore, "no bed taken at the receiving hospital");
  assert.deepEqual(t.family(), []);
});

// -- request_beds -------------------------------------------------------------------------------------
test("request_beds: approval stores 1 bed and normal urgency when the action leaves them out", () => {
  const t = blankTwin();
  const b = planFrom(t, {
    ICU: [{ type: "request_beds", beds: 2, urgency: "high" }],
    Ward: [{ type: "request_beds" }],
  });
  t.decide(b.id, "approve");
  const requests = t.snapshot().pendingRequests.map(({ unit, beds, urgency, tick }) => ({ unit, beds, urgency, tick }));
  const tick = t.state.tick;
  assert.deepEqual(requests, [
    { unit: "ICU", beds: 2, urgency: "high", tick },
    { unit: "Ward", beds: 1, urgency: "normal", tick },
  ]);
  assert.deepEqual(t.census("ED").requestsFromOthers, [
    { unit: "ICU", beds: 2, urgency: "high" },
    { unit: "Ward", beds: 1, urgency: "normal" },
  ]);
  assert.deepEqual(t.census("Ward").requestsFromOthers, [{ unit: "ICU", beds: 2, urgency: "high" }], "not its own request");
});

// -- beds ---------------------------------------------------------------------------------------------------
test("beds: lowest free bed on admission, hallway when full, surge flag set", () => {
  const t = blankTwin();
  const s = t.state;
  const first = fill(s, "ED", 26);
  assert.deepEqual(first.map((p) => p.bed), Array.from({ length: 26 }, (_, i) => i + 1));
  s.removePatient(first[4].id); // bed 5 frees up
  t.surge();
  const surge = t.snapshot().patients.filter((p) => p.surge);
  assert.equal(surge.length, 20);
  assert.deepEqual(surge.slice(0, 3).map((p) => p.bed), [5, 27, 28]);
  assert.ok(surge.slice(3).every((p) => p.bed === null));
  assert.ok(t.snapshot().patients.filter((p) => !p.surge).every((p) => p.surge === false));
  checkInvariants(t, "surge beds");
});

test("beds: freed beds go to bedless patients oldest first, and beds never change within a unit", () => {
  const t = blankTwin();
  const s = t.state;
  const staying = fill(s, "Ward", 70);
  const leaving = fill(s, "Ward", 6, { expectedDischargeTick: s.tick + 1 });
  const hallwayOld = fill(s, "Ward", 1, { admitTick: s.tick - 3 })[0];
  const hallwayNew = fill(s, "Ward", 1, { admitTick: s.tick })[0];
  assert.equal(hallwayOld.bed, null);
  assert.equal(hallwayNew.bed, null);
  const bedsBefore = new Map(staying.map((p) => [p.id, p.bed]));
  const freed = leaving.map((p) => p.bed);

  s.rng.poisson = () => 0; // no arrivals, to keep the count exact
  sim.step(s);
  for (const p of staying) assert.equal(s.patients.get(p.id).bed, bedsBefore.get(p.id));
  assert.equal(s.patients.get(hallwayOld.id).bed, freed[0]);
  assert.equal(s.patients.get(hallwayNew.id).bed, freed[1]);
  checkInvariants(t, "fill");
});

test("beds: open_overflow adds bed numbers that bedless patients take", () => {
  const t = blankTwin();
  const s = t.state;
  fill(s, "ICU", 19);
  const hallway = fill(s, "ICU", 1)[0];
  assert.equal(hallway.bed, null);
  const b = planFrom(t, { ICU: [{ type: "open_overflow", beds: 2 }] });
  t.decide(b.id, "approve");
  assert.equal(t.snapshot().units.ICU.bedsStaffed, 21);
  assert.equal(s.patients.get(hallway.id).bed, 20);
  const transferred = waitFor(s, "ICU", { acuity: 4 });
  const b2 = planFrom(t, { ICU: [{ type: "accept_transfer", patientId: transferred.id, from: "ED" }] });
  t.decide(b2.id, "approve");
  assert.equal(s.patients.get(transferred.id).bed, 21);
  checkInvariants(t, "overflow");
});

// -- review fixes: moves in history, wording, bundle cap -----------------------------------------------
test("history: an approved plan counts transfers in and out in this hour's rows", () => {
  const t = blankTwin();
  const s = t.state;
  s.recordHistory({}, {}); // this hour's rows
  const icuWaiter = waitFor(s, "ICU", { acuity: 5 });
  const wardWaiter = waitFor(s, "Ward", { acuity: 3 });
  const leaver = fill(s, "ED", 1, { acuity: 4 })[0];
  const b = planFrom(t, {
    ICU: [{ type: "accept_transfer", patientId: icuWaiter.id, from: "Ward" }], // wrong claim: the queue says ED
    Ward: [{ type: "accept_transfer", patientId: wardWaiter.id }],
    ED: [{ type: "divert_to", patientId: leaver.id, hospital: RIX }],
  });
  const row = (u) => s.history[u].at(-1);
  for (const u of UNITS) assert.deepEqual([row(u).transfersIn, row(u).transfersOut], [0, 0], "nothing counted before approval");
  t.decide(b.id, "approve");
  assert.deepEqual([row("ED").transfersIn, row("ED").transfersOut], [0, 3]);
  assert.deepEqual([row("ICU").transfersIn, row("ICU").transfersOut], [1, 0]);
  assert.deepEqual([row("Ward").transfersIn, row("Ward").transfersOut], [1, 0]);
  assert.equal(row("ED").arrivals, 0, "moves are not arrivals");
});

test("accept_transfer: the plan row, family message and transfer animation use the queue's from-unit", () => {
  const t = blankTwin();
  const s = t.state;
  const icuWaiter = waitFor(s, "ICU", { acuity: 5 });
  const wardWaiter = waitFor(s, "Ward", { acuity: 3 });
  const b = planFrom(t, {
    ICU: [{ type: "accept_transfer", patientId: icuWaiter.id, from: "Ward" }],
    Ward: [{ type: "accept_transfer", patientId: wardWaiter.id }],
  });
  assert.deepEqual(b.rows.map((r) => r.movement), ["ED → ICU", "ED → Ward"]);
  t.decide(b.id, "approve");
  assert.deepEqual(t.snapshot().recentTransfers, [
    { from: "ED", to: "ICU", patientId: icuWaiter.id },
    { from: "ED", to: "Ward", patientId: wardWaiter.id },
  ]);
  const texts = t.family().map((m) => m.text).reverse();
  assert.match(texts[0], new RegExp(`^Patient ${icuWaiter.id} is moving from ED to ICU around \\d\\d:00\\. Confidence: high\\. Their records go with them\\.$`));
  assert.match(texts[1], /is moving from ED to Ward/);
});

test("wording: bed counts and diverts use the singular for one", () => {
  const t = blankTwin();
  const s = t.state;
  fill(s, "ICU", 19); // full: the Regional coordinator suggests diverts
  const one = waitFor(s, "ICU", { acuity: 5 });
  const b = planFrom(
    t,
    {
      ICU: [{ type: "open_overflow", beds: 1 }],
      Ward: [{ type: "request_beds", beds: 1 }, { type: "request_beds", beds: 3, urgency: "high" }],
      ED: [{ type: "open_overflow", beds: 2 }],
    },
    Object.fromEntries([cap(OWN, 0, 0), cap(SPREE, 0, 0), cap(RIX, 1, 0)].map((c) => [c.hospital, c])),
  );
  assert.deepEqual(
    b.rows.map((r) => r.movement),
    ["+2 overflow beds", "+1 overflow bed", "requested 1 bed (n/a)", "requested 3 beds (high)"],
  );
  // ICU opened a bed, so the one waiting patient fits and no divert is needed.
  assert.ok(!b.rows.some((r) => r.actionType === "divert_to"));
  s.units.ICU.bedsStaffed = 19;
  const b2 = planFrom(t, {}, Object.fromEntries([cap(OWN, 0, 0), cap(SPREE, 0, 0), cap(RIX, 1, 0)].map((c) => [c.hospital, c])));
  assert.equal(b2.rows.find((r) => r.actionType === "divert_to").patientId, one.id);
  assert.ok(t.log().some((l) => l.text === "suggested 1 divert for ICU patients who can't be taken locally this hour"));
  t.decide(b2.id, "reject", "x");
  const b3 = planFrom(t, { ICU: [{ type: "open_overflow", beds: 1 }] });
  t.decide(b3.id, "approve");
  assert.equal(t.family()[0].text, "ICU is opening 1 additional bed to handle demand. Confidence: high.");
});

test("summary: counts actions cleared by the Safety check, or says there were none", () => {
  const t = blankTwin();
  const empty = planFrom(t, {});
  assert.equal(empty.summary, `${empty.hourRange}: no actions this hour`);
  const b = planFrom(t, { ED: [{ type: "divert_ed" }], Ward: [{ type: "defer_elective" }] });
  assert.equal(b.summary, `${b.hourRange}: 1/2 actions cleared by the Safety check`);
  assert.equal(t.log()[0].actor, "Coordinator");
  assert.equal(t.log()[0].text, b.summary);
});

test("bundles: only the newest week of plans is kept, and the pending one is always among them", () => {
  const t = new Twin({ seed: 3 });
  for (let i = 0; i < coordinator.BUNDLE_LIMIT + 20; i++) t.tick();
  const snap = t.snapshot();
  assert.equal(snap.bundleCount, coordinator.BUNDLE_LIMIT);
  assert.equal(t.state.bundles.at(-1).id, snap.pendingBundle.id);
  assert.equal(t.state.bundles[0].id, snap.pendingBundle.id - coordinator.BUNDLE_LIMIT + 1);
});

test("log: the simulation speaks as 'Simulation', never 'Twin'", () => {
  const t = new Twin();
  t.surge();
  for (let i = 0; i < 10; i++) t.tick();
  const actors = new Set(t.log().map((l) => l.actor));
  assert.ok(actors.has("Simulation"));
  assert.ok(!actors.has("Twin"));
});
