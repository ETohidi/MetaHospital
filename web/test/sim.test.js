import { test } from "node:test";
import assert from "node:assert/strict";
import { createRng } from "../src/engine/rng.js";
import { NEIGHBOUR_REVERSION, NEIGHBOUR_SPIKE_PROBABILITY, OWN_HOSPITAL_NAME, TwinState } from "../src/engine/state.js";
import { HOSPITAL_BY_NAME } from "../src/data/places.js";
import * as sim from "../src/engine/sim.js";

// -- fixtures: a hospital with no patients, filled explicitly per test -------------
function blankState(tick = 10, seed = 1) {
  const s = new TwinState({ seed, rng: createRng(seed) });
  s.patients.clear();
  for (const u of Object.values(s.units)) {
    u.queue = [];
    u.rejections = [];
  }
  s.tick = tick;
  return s;
}

function fill(s, unit, n, extra = {}) {
  return Array.from({ length: n }, () =>
    s.addPatient({ unit, acuity: 2, condition: "other", admitTick: s.tick - 5, expectedDischargeTick: s.tick + 50, ...extra }),
  );
}

/** An ED patient waiting for a bed in `unit`. */
function boarder(s, unit, { acuity = unit === "ICU" ? 4 : 3, waitingTicks = 0, expectedDischargeTick = s.tick + 1 } = {}) {
  const [p] = fill(s, "ED", 1, { acuity, expectedDischargeTick });
  s.units[unit].queue.push({ patientId: p.id, from: "ED", acuity, condition: "other", waitingTicks });
  return p;
}

const noArrivals = (s) => (s.rng.poisson = () => 0);
const transferLines = (s) => s.log.filter((l) => l.text.includes("transferred out by the ED team"));

// -- boarding (change 2) --------------------------------------------------------------------------
test("boarding: a patient waiting for a bed upstairs keeps their ED bed past their expected discharge", () => {
  const s = blankState(10);
  noArrivals(s);
  const waiting = boarder(s, "ICU", { expectedDischargeTick: 11 });
  const [goesHome] = fill(s, "ED", 1, { expectedDischargeTick: 11 }); // not waiting for anything
  for (let h = 1; h < sim.MAX_BOARDING_TICKS; h++) {
    sim.step(s);
    assert.ok(s.patients.has(waiting.id), `still in the ED after ${h}h`);
    assert.equal(s.patients.get(waiting.id).unit, "ED");
    assert.equal(s.units.ICU.queue[0].waitingTicks, h);
  }
  assert.ok(!s.patients.has(goesHome.id), "a patient not waiting for a bed is discharged on time");
  assert.equal(s.patients.get(waiting.id).bed, 1, "the boarder keeps their bed");
  assert.deepEqual(transferLines(s), []);
});

test("boarding: after 6 hours of waiting the ED team transfers the patient out, with one log line", () => {
  const s = blankState(10);
  noArrivals(s);
  assert.equal(sim.MAX_BOARDING_TICKS, 6);
  // Due home long after the transfer-out: the wait alone decides.
  const waiting = boarder(s, "ICU", { expectedDischargeTick: 60 });
  for (let h = 1; h <= 5; h++) sim.step(s);
  assert.ok(s.patients.has(waiting.id));
  sim.step(s); // the 6th hour
  assert.equal(s.tick, 16);
  assert.ok(!s.patients.has(waiting.id));
  assert.deepEqual(s.units.ICU.queue, []);
  assert.deepEqual(
    transferLines(s).map((l) => [l.tick, l.actor, l.level, l.text]),
    [[16, "Simulation", "warn", "1 patient waited 6 hours in the ED for a bed upstairs and was transferred out by the ED team."]],
  );
  assert.equal(s.history.ED.at(-1).discharges, 1, "they leave the ED");
});

test("boarding: patients from both queues are transferred out together, one aggregated line per hour", () => {
  const s = blankState(10);
  noArrivals(s);
  const a = boarder(s, "ICU", { waitingTicks: 3 });
  const b = boarder(s, "Ward", { waitingTicks: 3 });
  const later = boarder(s, "Ward", { waitingTicks: 1 });
  for (let h = 1; h <= 3; h++) sim.step(s);
  assert.ok(!s.patients.has(a.id) && !s.patients.has(b.id));
  assert.ok(s.patients.has(later.id), "has waited only 4 hours");
  assert.deepEqual(
    transferLines(s).map((l) => [l.tick, l.text]),
    [[13, "2 patients waited 6 hours in the ED for a bed upstairs and were transferred out by the ED team."]],
  );
  sim.step(s);
  sim.step(s);
  assert.ok(!s.patients.has(later.id));
  assert.deepEqual(
    transferLines(s).map((l) => l.tick),
    [13, 15],
  );
  assert.equal(transferLines(s)[1].text, "1 patient waited 6 hours in the ED for a bed upstairs and was transferred out by the ED team.");
});

// -- admission routing and ED length of stay (change 1) ------------------------------------------------
test("ED arrivals: acuity 4-5 wait for ICU, acuity 3 for the Ward, 1-2 go home; ED stays last 2-6 hours", () => {
  assert.equal(sim.ICU_ADMIT_MIN_ACUITY, 4);
  assert.equal(sim.WARD_ADMIT_MIN_ACUITY, 3);
  const s = blankState(10);
  s.rng.poisson = (mean) => (mean === sim.ARRIVAL_MEANS.ED ? 60 : 0);
  sim.step(s);
  const arrived = s.unitPatients("ED").filter((p) => p.admitTick === 11);
  assert.equal(arrived.length, 60);
  const inQueue = (unit, id) => s.units[unit].queue.some((q) => q.patientId === id);
  const seen = new Set();
  for (const p of arrived) {
    seen.add(p.acuity);
    assert.equal(inQueue("ICU", p.id), p.acuity >= 4, `${p.id} acuity ${p.acuity} ICU queue`);
    assert.equal(inQueue("Ward", p.id), p.acuity === 3, `${p.id} acuity ${p.acuity} Ward queue`);
    const los = p.expectedDischargeTick - p.admitTick;
    assert.ok(Number.isInteger(los) && los >= 2 && los <= 6, `ED stay ${los}`);
  }
  assert.deepEqual([...seen].sort(), [1, 2, 3, 4, 5]);
});

test("ED length of stay covers 2-6 hours", () => {
  const rng = createRng(3);
  const draws = Array.from({ length: 2000 }, () => sim.sampleLos(rng, "ED"));
  assert.equal(Math.min(...draws), 2);
  assert.equal(Math.max(...draws), 6);
  const mean = draws.reduce((a, b) => a + b, 0) / draws.length;
  assert.ok(mean > 3.5 && mean < 4.5, `mean ${mean}`);
});

// -- the bus accident (change 3) ---------------------------------------------------------------------
test("surge: casualties are triaged by SURGE_ACUITY_WEIGHTS and queued by acuity", () => {
  assert.deepEqual(sim.SURGE_ACUITY_WEIGHTS, { 2: 0.3, 3: 0.35, 4: 0.25, 5: 0.1 });
  const s = blankState(10, 7);
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (let i = 0; i < 50; i++) {
    sim.injectSurge(s);
    const casualties = [...s.patients.values()];
    for (const p of casualties) {
      counts[p.acuity] += 1;
      assert.equal(p.surge, true);
      assert.equal(p.unit, "ED");
      const icu = s.units.ICU.queue.some((q) => q.patientId === p.id);
      const ward = s.units.Ward.queue.some((q) => q.patientId === p.id);
      assert.deepEqual([icu, ward], [p.acuity >= 4, p.acuity === 3], `acuity ${p.acuity}`);
    }
    s.patients.clear();
    for (const u of Object.values(s.units)) u.queue = [];
  }
  assert.equal(counts[1], 0, "nobody from the bus is triaged acuity 1");
  for (const [acuity, weight] of Object.entries(sim.SURGE_ACUITY_WEIGHTS)) {
    const share = counts[acuity] / 1000;
    assert.ok(Math.abs(share - weight) < 0.05, `acuity ${acuity}: ${share} vs ${weight}`);
  }
});

test("surge: the casualties count as arrivals in this hour's history row, which is refreshed", () => {
  const s = blankState(10);
  noArrivals(s);
  fill(s, "ED", 5);
  sim.step(s); // tick 11: a quiet hour
  const edBefore = structuredClone(s.history.ED.at(-1));
  const rows = s.history.ED.length;
  assert.equal(edBefore.arrivals, 0);
  assert.equal(edBefore.surgeArrivals, 0);

  sim.injectSurge(s);
  assert.equal(s.history.ED.length, rows, "no extra row");
  const ed = s.history.ED.at(-1);
  assert.equal(ed.tick, 11);
  assert.equal(ed.arrivals, sim.SURGE_ARRIVALS);
  assert.equal(ed.surgeArrivals, sim.SURGE_ARRIVALS);
  assert.equal(ed.inUse, 25);
  assert.equal(ed.inUse, s.occupied("ED"));
  assert.equal(ed.discharges, edBefore.discharges);
  for (const u of ["ICU", "Ward"]) {
    const row = s.history[u].at(-1);
    assert.equal(row.queueLength, s.units[u].queue.length, `${u} queue length refreshed`);
    assert.equal(row.surgeArrivals, 0);
    assert.equal(row.arrivals, 0);
  }
  assert.ok(s.history.ICU.at(-1).queueLength + s.history.Ward.at(-1).queueLength > 0);

  sim.step(s); // the next hour starts a fresh row
  assert.equal(s.history.ED.at(-1).tick, 12);
  assert.equal(s.history.ED.at(-1).surgeArrivals, 0);
  assert.equal(s.history.ED.at(-2).surgeArrivals, sim.SURGE_ARRIVALS);
});

test("surge: an older history row is left alone when this hour has no row yet", () => {
  const s = blankState(10);
  const last = structuredClone(s.history.ED.at(-1)); // tick 0, from the constructor
  sim.injectSurge(s);
  assert.deepEqual(s.history.ED.at(-1), last);
});

test("projection: the emergency is left out of the usual arrival rate", () => {
  const s = blankState(10);
  const row = (tick, arrivals) => ({ tick, time: "", inUse: 0, usable: 28, arrivals, surgeArrivals: 0, discharges: 0, queueLength: 0 });
  s.history.ED = [row(9, 4), row(10, 4)];
  sim.injectSurge(s);
  assert.equal(s.history.ED.at(-1).arrivals, 24);
  // Look at the arrival rate alone: nobody in the ED, nothing scheduled.
  for (const p of s.unitPatients("ED")) s.removePatient(p.id);
  // 4 per hour (the surge left out), not (4 + 24) / 2 = 14 per hour.
  assert.deepEqual(s.projection("ED").map((r) => r.projectedInUse), [4, 8, 12, 16, 20, 24]);
  // Rows from before the field existed still work.
  delete s.history.ED[0].surgeArrivals;
  assert.equal(s.projection("ED")[0].projectedInUse, 4);
});

test("projection: net inflow counts approved moves in and out; queued patients leave by transfer, not schedule", () => {
  const s = blankState(10);
  const row = (tick, extra) => ({
    tick, time: "", inUse: 0, usable: 19, arrivals: 0, surgeArrivals: 0, discharges: 0,
    transfersIn: 0, transfersOut: 0, queueLength: 0, ...extra,
  });
  // ICU: 1 arrival and 2 transfers in per hour, 1 transfer out (a divert) -> +2 per hour.
  s.history.ICU = [row(9, { arrivals: 1, transfersIn: 2, transfersOut: 1 }), row(10, { arrivals: 1, transfersIn: 2, transfersOut: 1 })];
  assert.deepEqual(s.projection("ICU").map((r) => r.projectedInUse), [2, 4, 6, 8, 10, 12]);

  // ED: 6 arrivals, 5 moved upstairs per hour -> +1 per hour. Two boarders are due by schedule
  // in 2 hours but are waiting for a bed upstairs, so only the third patient's discharge counts.
  s.history.ED = [row(9, { arrivals: 6, transfersOut: 5 }), row(10, { arrivals: 6, transfersOut: 5 })];
  const boarders = fill(s, "ED", 2, { acuity: 4, expectedDischargeTick: 12 });
  fill(s, "ED", 1, { expectedDischargeTick: 12 });
  for (const p of boarders) s.units.ICU.queue.push({ patientId: p.id, from: "ED", acuity: 4, condition: "other", waitingTicks: 1 });
  assert.deepEqual(s.projection("ED").map((r) => r.projectedInUse), [4, 4, 5, 6, 7, 8]);

  // Rows from before the transfer fields existed still work.
  s.history.ICU = [{ tick: 10, time: "", inUse: 0, usable: 19, arrivals: 1, surgeArrivals: 0, discharges: 0, queueLength: 0 }];
  assert.equal(s.projection("ICU")[0].projectedInUse, 1);
});

test("projection: the emergency stays out of the rate when transfers are counted too", () => {
  const s = blankState(10);
  const row = (tick, arrivals) => ({
    tick, time: "", inUse: 0, usable: 28, arrivals, surgeArrivals: 0, discharges: 0,
    transfersIn: 0, transfersOut: 2, queueLength: 0,
  });
  s.history.ED = [row(9, 6), row(10, 6)];
  sim.injectSurge(s);
  for (const p of s.unitPatients("ED")) s.removePatient(p.id);
  // (6 - 2) per hour; the 20 casualties would make it (6 + 26) / 2 - 2 = 14.
  assert.deepEqual(s.projection("ED").map((r) => r.projectedInUse), [4, 8, 12, 16, 20, 24]);
});

// -- free beds are never negative (change 4) ------------------------------------------------------------
test("free beds: hospital history and the capacity census clamp at 0 when a unit is over capacity", () => {
  const s = blankState(10);
  fill(s, "ED", 31); // 28 usable
  s.recordHospitalHistory();
  assert.equal(s.hospitalHistory[OWN_HOSPITAL_NAME].at(-1).freeBeds.ED, 0);
  assert.equal(s.hospitalCensus(OWN_HOSPITAL_NAME).freeBeds.ED, 0);
  assert.equal(s.hospitalCensus(OWN_HOSPITAL_NAME).freeBeds.ICU, 19);

  const rix = "Rixdorf Hospital";
  s.neighbours[rix].ICU.bedsOccupied = s.neighbours[rix].ICU.bedsStaffed + 3;
  s.recordHospitalHistory();
  assert.equal(s.hospitalHistory[rix].at(-1).freeBeds.ICU, 0);
  assert.equal(s.hospitalCensus(rix).freeBeds.ICU, 0);
});

// -- neighbours (change 5) ----------------------------------------------------------------------------------
const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);

test("neighbours: occupancy stays within [0, usable beds] every hour for 200 hours", () => {
  for (const seed of SEEDS) {
    const s = new TwinState({ seed, rng: createRng(seed) });
    for (let i = 0; i < 200; i++) {
      s.driftNeighbours();
      for (const [name, hosp] of Object.entries(s.neighbours)) {
        for (const [unit, b] of Object.entries(hosp)) {
          assert.ok(Number.isInteger(b.bedsOccupied), `${seed} ${name} ${unit}`);
          assert.ok(b.bedsOccupied >= 0 && b.bedsOccupied <= b.bedsStaffed, `seed ${seed}, hour ${i}: ${name} ${unit} ${b.bedsOccupied}`);
        }
      }
    }
  }
});

test("neighbours: occupancy hovers near each hospital's usual (seed) level over 200 hours", () => {
  // Pooled over 20 seeds so no single run's luck decides. Observed mean vs seed occupancy:
  // Spreebogen ED +13.1%, ICU +6.1%, Ward +23.5%; Rixdorf ED +7.0%, ICU +1.3%, Ward +20.8%.
  // The Wards sit well above their seed level: a spike to full takes them ~18 beds up and
  // the drift back is at most 1 bed per hour (see the report on driftNeighbours).
  const sums = {};
  for (const seed of SEEDS) {
    const s = new TwinState({ seed, rng: createRng(seed) });
    for (let i = 0; i < 200; i++) {
      s.driftNeighbours();
      for (const [name, hosp] of Object.entries(s.neighbours)) {
        for (const [unit, b] of Object.entries(hosp)) sums[`${name}|${unit}`] = (sums[`${name}|${unit}`] ?? 0) + b.bedsOccupied;
      }
    }
  }
  assert.equal(Object.keys(sums).length, 6);
  for (const [key, sum] of Object.entries(sums)) {
    const [name, unit] = key.split("|");
    const usual = HOSPITAL_BY_NAME[name].seed[unit][2];
    const mean = sum / (200 * SEEDS.length);
    assert.ok(Math.abs(mean / usual - 1) <= 0.25, `${name} ${unit}: mean ${mean.toFixed(1)} vs usual ${usual}`);
  }
});

test("neighbours: a hospital emptied or filled drifts back toward its usual level", () => {
  // Pooled over 20 seeds, after 50 hours. Observed: from empty every unit is back within
  // +14% of usual; from full every unit is at least half of the way back (Spreebogen Ward
  // exactly 0.50, Rixdorf Ward 0.61, the rest 0.72-0.95): spikes keep refilling the Wards.
  for (const start of ["empty", "full"]) {
    const sums = {};
    for (const seed of SEEDS) {
      const s = new TwinState({ seed, rng: createRng(seed) });
      for (const hosp of Object.values(s.neighbours)) {
        for (const b of Object.values(hosp)) b.bedsOccupied = start === "empty" ? 0 : b.bedsStaffed;
      }
      for (let i = 0; i < 50; i++) s.driftNeighbours();
      for (const [name, hosp] of Object.entries(s.neighbours)) {
        for (const [unit, b] of Object.entries(hosp)) sums[`${name}|${unit}`] = (sums[`${name}|${unit}`] ?? 0) + b.bedsOccupied;
      }
    }
    for (const [key, sum] of Object.entries(sums)) {
      const [name, unit] = key.split("|");
      const [, staffed, usual] = HOSPITAL_BY_NAME[name].seed[unit];
      const mean = sum / SEEDS.length;
      const ctx = `${start} ${name} ${unit}: ${mean.toFixed(1)} vs usual ${usual}`;
      if (start === "empty") {
        assert.ok(Math.abs(mean / usual - 1) <= 0.25, ctx);
      } else {
        const wayBack = (staffed - mean) / (staffed - usual);
        assert.ok(wayBack >= 1 / 3, `${ctx} (${wayBack.toFixed(2)} of the way back)`);
      }
    }
  }
});

test("neighbours: spikes to full happen, but rarely", () => {
  // An ordinary hour moves a unit by at most 2 random beds plus a fifth of its gap to the
  // usual level (rounded), so a bigger rise can only be a spike, and a spike lands on full.
  let spikes = 0;
  let unitHours = 0;
  for (const seed of SEEDS) {
    const s = new TwinState({ seed, rng: createRng(seed) });
    for (let i = 0; i < 200; i++) {
      const before = structuredClone(s.neighbours);
      s.driftNeighbours();
      for (const [name, hosp] of Object.entries(s.neighbours)) {
        const usual = HOSPITAL_BY_NAME[name].seed;
        for (const [unit, b] of Object.entries(hosp)) {
          unitHours += 1;
          const was = before[name][unit].bedsOccupied;
          const pull = Math.round((usual[unit][2] - was) * NEIGHBOUR_REVERSION);
          const change = b.bedsOccupied - was;
          assert.ok(change >= Math.min(0, pull) - 2, `${name} ${unit} fell by ${-change}`);
          if (change > Math.max(0, pull) + 2) {
            spikes += 1;
            assert.equal(b.bedsOccupied, b.bedsStaffed, "a spike fills the unit");
          }
        }
      }
    }
  }
  assert.ok(spikes > 0, "no spike at all");
  assert.ok(spikes <= unitHours * NEIGHBOUR_SPIKE_PROBABILITY, `${spikes} spikes in ${unitHours} unit-hours`);
});
