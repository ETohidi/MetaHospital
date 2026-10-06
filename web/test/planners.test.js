import { test } from "node:test";
import assert from "node:assert/strict";
import { createRng } from "../src/engine/rng.js";
import { TwinState } from "../src/engine/state.js";
import * as planners from "../src/engine/planners.js";
import * as safety from "../src/engine/safety.js";
import { ED_DIVERT_TICKS } from "../src/engine/sim.js";

// -- fixtures: a hospital with no patients, filled explicitly per test -------------
function blankState(tick = 10) {
  const s = new TwinState({ seed: 1, rng: createRng(1) });
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

function waitFor(s, unit, { acuity, waitingTicks, condition = "other" }) {
  const [p] = fill(s, "ED", 1, { acuity, condition });
  s.units[unit].queue.push({ patientId: p.id, from: "ED", acuity, condition, waitingTicks });
  return p;
}

/** ED history whose previous hour had `previous` patients (the planner compares with it). */
function edPreviousHour(s, previous) {
  const row = (tick, inUse) => ({ tick, time: "", inUse, usable: 28, arrivals: 0, surgeArrivals: 0, discharges: 0, queueLength: 0 });
  s.history.ED = [row(s.tick - 1, previous), row(s.tick, s.occupied("ED"))];
}

const ids = (proposal) => proposal.actions.map((a) => a.patientId);

// -- ICU: every patient it has beds for, sickest first --------------------------------
test("ICU planner takes as many waiting patients as it has free beds, sickest first", () => {
  const s = blankState();
  fill(s, "ICU", 16); // 3 of 19 free
  const a = waitFor(s, "ICU", { acuity: 4, waitingTicks: 5 });
  const b = waitFor(s, "ICU", { acuity: 5, waitingTicks: 1 });
  const c = waitFor(s, "ICU", { acuity: 5, waitingTicks: 3, condition: "stroke" });
  const d = waitFor(s, "ICU", { acuity: 3, waitingTicks: 9 });
  const e = waitFor(s, "ICU", { acuity: 4, waitingTicks: 2 });
  const queueBefore = s.units.ICU.queue.map((q) => q.patientId);

  const p = planners.generate("ICU", s);
  assert.deepEqual(ids(p), [c.id, b.id, a.id], "acuity first, then the longer wait");
  assert.equal(p.rationale, "Taking 3 waiting patients, sickest first. 2 more can't get an ICU bed this hour.");
  assert.equal(p.confidence, 0.75);
  assert.deepEqual(p.actions[0], {
    type: "accept_transfer",
    patientId: c.id,
    from: "ED",
    confidence: 0.75,
    reason: "stroke patient, acuity 5; ICU bed available.",
  });
  assert.deepEqual(s.units.ICU.queue.map((q) => q.patientId), queueBefore, "the queue itself is not reordered");
  assert.ok(!ids(p).includes(d.id) && !ids(p).includes(e.id));

  // The safety check lets every one of them through: they fit exactly.
  const res = safety.evaluate([p], s);
  assert.ok(res.entries.every((x) => !x.blocked));
  assert.equal(res.after.ICU, 19);
});

test("ICU planner: everyone fits, one fits, full, over capacity, nobody waiting", () => {
  let s = blankState();
  fill(s, "ICU", 10);
  const x = waitFor(s, "ICU", { acuity: 4, waitingTicks: 1 });
  const y = waitFor(s, "ICU", { acuity: 5, waitingTicks: 1 });
  let p = planners.generate("ICU", s);
  assert.deepEqual(ids(p), [y.id, x.id]);
  assert.equal(p.rationale, "Taking 2 waiting patients, sickest first.");

  s = blankState();
  fill(s, "ICU", 18);
  const only = waitFor(s, "ICU", { acuity: 4, waitingTicks: 1 });
  p = planners.generate("ICU", s);
  assert.deepEqual(ids(p), [only.id]);
  assert.equal(p.rationale, "Taking 1 waiting patient, sickest first.");

  for (const occupied of [19, 21]) {
    s = blankState();
    fill(s, "ICU", occupied);
    waitFor(s, "ICU", { acuity: 5, waitingTicks: 1 });
    p = planners.generate("ICU", s);
    assert.deepEqual(p.actions, [], `${occupied}/19`);
    assert.equal(p.rationale, "No free ICU beds; holding position.");
    assert.equal(p.confidence, 0.5);
  }

  s = blankState();
  fill(s, "ICU", 5);
  p = planners.generate("ICU", s);
  assert.deepEqual(p.actions, []);
  assert.equal(p.rationale, "Nobody is waiting for an ICU bed.");
});

// -- Ward: every patient it has beds for, longest waiting first --------------------------
test("Ward planner takes as many waiting patients as it has free beds, longest waiting first", () => {
  const s = blankState();
  fill(s, "Ward", 74); // 2 of 76 free
  const a = waitFor(s, "Ward", { acuity: 3, waitingTicks: 2 });
  const b = waitFor(s, "Ward", { acuity: 2, waitingTicks: 5 });
  const c = waitFor(s, "Ward", { acuity: 3, waitingTicks: 5 });
  const d = waitFor(s, "Ward", { acuity: 3, waitingTicks: 1 });

  const p = planners.generate("Ward", s);
  assert.deepEqual(ids(p), [c.id, b.id], "the longest wait first, then the higher acuity");
  assert.equal(p.rationale, "Taking 2 waiting patients into free Ward beds, longest wait first. 2 more wait for the next free bed.");
  assert.equal(p.confidence, 0.65);
  assert.equal(p.actions[1].reason, "other patient, acuity 2; Ward bed available.");
  assert.ok(!ids(p).includes(a.id) && !ids(p).includes(d.id));
  const res = safety.evaluate([p], s);
  assert.ok(res.entries.every((x) => !x.blocked));
  assert.equal(res.after.Ward, 76);
});

test("Ward planner: everyone fits, full, nobody waiting", () => {
  let s = blankState();
  fill(s, "Ward", 40);
  const [x, y, z] = [1, 3, 2].map((w) => waitFor(s, "Ward", { acuity: 3, waitingTicks: w }));
  let p = planners.generate("Ward", s);
  assert.deepEqual(ids(p), [y.id, z.id, x.id]);
  assert.equal(p.rationale, "Taking 3 waiting patients into free Ward beds, longest wait first.");

  s = blankState();
  fill(s, "Ward", 76);
  waitFor(s, "Ward", { acuity: 3, waitingTicks: 4 });
  p = planners.generate("Ward", s);
  assert.deepEqual(p.actions, []);
  assert.equal(p.rationale, "No free Ward beds this hour.");

  s = blankState();
  p = planners.generate("Ward", s);
  assert.deepEqual(p.actions, []);
  assert.equal(p.rationale, "No action needed this hour.");
});

// -- ED copy ------------------------------------------------------------------------------------
test("ED planner speaks of usable beds, and says 'and rising' only when ED has more patients than an hour ago", () => {
  const s = blankState();
  fill(s, "ED", 26); // 93%
  edPreviousHour(s, 22);
  let p = planners.generate("ED", s);
  assert.equal(p.actions[0].type, "divert_ed");
  assert.equal(p.actions[0].confidence, 0.6);
  assert.equal(p.rationale, "ED at 93% of usable beds and rising; diverting ambulances before we're overwhelmed.");
  assert.equal(p.actions[0].reason, "ED at 93% of usable beds and rising; the whole unit, not one patient.");

  for (const previous of [26, 28]) {
    edPreviousHour(s, previous);
    p = planners.generate("ED", s);
    assert.equal(p.rationale, "ED at 93% of usable beds; diverting ambulances before we're overwhelmed.", `previous ${previous}`);
  }

  fill(s, "ED", 1); // 27/28 = 96%
  p = planners.generate("ED", s);
  assert.equal(p.rationale, "ED at 96% of usable beds; diverting incoming ambulances.");
  assert.equal(p.actions[0].reason, "ED at 96% of usable beds; the whole unit is full, not one patient.");
});

// -- ED: asking to keep an approved diversion going ----------------------------------------------
test("ED planner asks to keep diverting while a diversion runs; the safety check allows it only above 95%", () => {
  const cases = [
    // [ED patients of 28, expected confidence, blocked]
    [15, 0.55, true], // 54%: well under the preview band
    [22, 0.55, true], // 79%
    [26, 0.55, true], // 93%
    [27, 0.85, false], // 96%: really full, the ordinary divert
  ];
  for (const [n, confidence, blocked] of cases) {
    const s = blankState();
    fill(s, "ED", n);
    s.edDivertTicksRemaining = 1;
    const p = planners.generate("ED", s);
    assert.equal(p.actions.length, 1, `${n}/28`);
    assert.equal(p.actions[0].type, "divert_ed");
    assert.equal(p.actions[0].confidence, confidence, `${n}/28`);
    const entry = safety.evaluate([p], s).entries[0];
    assert.equal(entry.blocked, blocked, `${n}/28`);
    assert.equal(entry.rule, blocked ? safety.RULE_DIVERT_ED : null);
  }

  const s = blankState();
  fill(s, "ED", 20); // 71%
  s.edDivertTicksRemaining = 2;
  const p = planners.generate("ED", s);
  assert.equal(
    p.rationale,
    `Ambulances are still diverted and ED is at 71% of usable beds; asking to keep diverting for another ${ED_DIVERT_TICKS} hours.`,
  );
  assert.equal(p.actions[0].reason, "ED at 71% of usable beds; keep diverting ambulances until the emergency backlog clears.");
  assert.equal(p.confidence, 0.55);

  // Exactly 95% is not above 95%: still the (blocked) request to keep diverting.
  const edge = blankState();
  edge.units.ED.bedsStaffed = 20;
  fill(edge, "ED", 19);
  edge.edDivertTicksRemaining = 1;
  const q = planners.generate("ED", edge);
  assert.equal(q.actions[0].confidence, 0.55);
  assert.equal(safety.evaluate([q], edge).entries[0].rule, safety.RULE_DIVERT_ED);
});

test("ED planner stops asking to keep diverting once the diversion ended or after a rejection", () => {
  // Diversion over: back to the ordinary rules (71% needs nothing).
  let s = blankState();
  fill(s, "ED", 20);
  s.edDivertTicksRemaining = 0;
  let p = planners.generate("ED", s);
  assert.deepEqual(p.actions, []);
  assert.equal(p.rationale, "ED occupancy within normal range; no action needed.");

  // A recent rejection: no second ask, whatever the occupancy under 95%.
  s = blankState();
  fill(s, "ED", 20);
  s.edDivertTicksRemaining = 1;
  s.addRejection("ED", "Wrong priority order");
  p = planners.generate("ED", s);
  assert.deepEqual(p.actions, []);
  assert.equal(p.rationale, "ED occupancy within normal range; no action needed. (Noting recent rejection: Wrong priority order)");

  fill(s, "ED", 6); // 93%: asks for beds instead
  p = planners.generate("ED", s);
  assert.equal(p.actions[0].type, "request_beds");
  assert.equal(p.actions[0].reason, "ED at 93% of usable beds; asking for help instead of diverting again.");
});

test("generateFromCensus matches generate for units without history-dependent wording", () => {
  const s = blankState();
  fill(s, "ICU", 17);
  waitFor(s, "ICU", { acuity: 5, waitingTicks: 1 });
  waitFor(s, "Ward", { acuity: 3, waitingTicks: 1 });
  for (const unit of ["ICU", "Ward"]) {
    assert.deepEqual(planners.generateFromCensus(s.census(unit)), planners.generate(unit, s), unit);
  }
});
