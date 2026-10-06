import { test } from "node:test";
import assert from "node:assert/strict";
import { createRng } from "../src/engine/rng.js";
import { TwinState } from "../src/engine/state.js";
import * as safety from "../src/engine/safety.js";

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
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(
      s.addPatient({
        unit,
        acuity: 2,
        condition: "other",
        admitTick: s.tick - 5,
        expectedDischargeTick: s.tick + 50,
        ...extra,
      }),
    );
  }
  return out;
}

function enqueue(s, unit, patient, waitingTicks = 1) {
  s.units[unit].queue.push({
    patientId: patient.id,
    from: patient.unit,
    acuity: patient.acuity,
    condition: patient.condition,
    waitingTicks,
  });
}

const prop = (unit, actions, extra = {}) => ({
  unit,
  author: `${unit} planner`,
  actions,
  rationale: "test",
  confidence: 0.8,
  risks: [],
  ...extra,
});

const rules = (result) => result.entries.map((e) => e.rule);

// -- proposal shape --------------------------------------------------------------------
test("proposal shape: empty rationale or confidence outside [0, 1] blocks every action", () => {
  const s = blankState();
  const a = { type: "request_beds", beds: 1, urgency: "low" };
  const res = safety.evaluate(
    [prop("ED", [a], { rationale: "  " }), prop("ICU", [a], { confidence: 1.2 }), prop("Ward", [a])],
    s,
  );
  assert.deepEqual(rules(res), [safety.RULE_PROPOSAL_SHAPE, safety.RULE_PROPOSAL_SHAPE, null]);
  assert.equal(res.proposals.length, 1);
  assert.equal(res.proposals[0].unit, "Ward");
  assert.equal(res.entries[0].author, "ED planner");
});

// -- accept_transfer: staffed cap ---------------------------------------------------------
test("staffed cap: accept_transfer allowed with a free bed, blocked once the unit is full", () => {
  const s = blankState();
  fill(s, "ICU", 18); // staffed 19
  const [p1, p2] = fill(s, "ED", 2, { acuity: 4 });
  enqueue(s, "ICU", p1);
  enqueue(s, "ICU", p2);
  const res = safety.evaluate(
    [prop("ICU", [{ type: "accept_transfer", patientId: p1.id, from: "ED" }, { type: "accept_transfer", patientId: p2.id, from: "ED" }])],
    s,
  );
  assert.deepEqual(rules(res), [null, safety.RULE_STAFFED_CAP]);
  assert.equal(res.after.ICU, 19);
  assert.equal(res.after.ED, 1);
  assert.equal(res.before.ICU, 18);
  assert.equal(res.proposals[0].actions.length, 1);
});

// -- accept_transfer: queue -------------------------------------------------------------------
test("accept_transfer only for a patient waiting in this unit's queue", () => {
  const s = blankState();
  const [inWardQueue] = fill(s, "ED", 1, { acuity: 3 });
  enqueue(s, "Ward", inWardQueue);
  const res = safety.evaluate(
    [
      prop("ICU", [
        { type: "accept_transfer", patientId: inWardQueue.id, from: "ED" }, // queued for Ward, not ICU
        { type: "accept_transfer", patientId: "p999", from: "ED" }, // does not exist
      ]),
      prop("Ward", [{ type: "accept_transfer", patientId: inWardQueue.id, from: "ED" }]),
    ],
    s,
  );
  assert.deepEqual(rules(res), [safety.RULE_ACCEPT_TRANSFER_QUEUE, safety.RULE_ACCEPT_TRANSFER_QUEUE, null]);
});

test("the projection uses the queue item's from-unit, not the action's claim", () => {
  const s = blankState();
  fill(s, "Ward", 10);
  const [p] = fill(s, "ED", 1, { acuity: 3 });
  enqueue(s, "Ward", p); // really from ED
  const res = safety.evaluate([prop("Ward", [{ type: "accept_transfer", patientId: p.id, from: "ICU" }])], s);
  assert.equal(res.entries[0].blocked, false);
  assert.equal(res.after.ED, 0);
  assert.equal(res.after.ICU, 0);
  assert.equal(res.after.Ward, 11);
});

// -- expedite_discharge ---------------------------------------------------------------------
test("expedite_discharge: blocked for acuity >= 4, short stays or unknown patients; allowed otherwise", () => {
  const s = blankState(10);
  const [sick] = fill(s, "Ward", 1, { acuity: 4 });
  const [fresh] = fill(s, "Ward", 1, { acuity: 2, admitTick: 9 });
  const [ok] = fill(s, "Ward", 1, { acuity: 2, admitTick: 8 });
  const res = safety.evaluate(
    [
      prop("Ward", [
        { type: "expedite_discharge", patientId: sick.id, targetTick: 11 },
        { type: "expedite_discharge", patientId: fresh.id, targetTick: 11 },
        { type: "expedite_discharge", patientId: "p999", targetTick: 11 },
        { type: "expedite_discharge", patientId: ok.id, targetTick: 11 },
      ]),
    ],
    s,
  );
  assert.deepEqual(rules(res), [
    safety.RULE_EXPEDITE_DISCHARGE,
    safety.RULE_EXPEDITE_DISCHARGE,
    safety.RULE_EXPEDITE_DISCHARGE,
    null,
  ]);
});

test("expedite_discharge needs a target time in the future", () => {
  const s = blankState(10);
  const [p] = fill(s, "Ward", 1, { acuity: 2, admitTick: 2 });
  const res = safety.evaluate(
    [
      prop("Ward", [
        { type: "expedite_discharge", patientId: p.id },
        { type: "expedite_discharge", patientId: p.id, targetTick: 10 },
        { type: "expedite_discharge", patientId: p.id, targetTick: 12 },
      ]),
    ],
    s,
  );
  assert.deepEqual(rules(res), [safety.RULE_EXPEDITE_TARGET, safety.RULE_EXPEDITE_TARGET, null]);
});

test("expedite_discharge: the target must be earlier than the patient's planned discharge", () => {
  const s = blankState(10);
  const [p, q, r, t] = fill(s, "Ward", 4, { acuity: 2, admitTick: 2, expectedDischargeTick: 14 });
  const res = safety.evaluate(
    [
      prop("Ward", [
        { type: "expedite_discharge", patientId: p.id, targetTick: 13 }, // an hour early
        { type: "expedite_discharge", patientId: q.id, targetTick: 11 }, // the earliest possible
        { type: "expedite_discharge", patientId: r.id, targetTick: 14 }, // as planned: not early
        { type: "expedite_discharge", patientId: t.id, targetTick: 18 }, // later: not early
      ]),
    ],
    s,
  );
  assert.deepEqual(rules(res), [null, null, safety.RULE_EXPEDITE_TARGET, safety.RULE_EXPEDITE_TARGET]);
  assert.equal(res.proposals[0].actions.length, 2);
  // A patient due next hour can't be discharged any earlier.
  const [dueSoon] = fill(s, "Ward", 1, { acuity: 2, admitTick: 2, expectedDischargeTick: 11 });
  const soon = safety.evaluate([prop("Ward", [{ type: "expedite_discharge", patientId: dueSoon.id, targetTick: 11 }])], s);
  assert.equal(soon.entries[0].rule, safety.RULE_EXPEDITE_TARGET);
});

// -- open_overflow ---------------------------------------------------------------------------
test("open_overflow: at most +2 beds per unit per hour, and it raises capacity for transfers", () => {
  const s = blankState();
  fill(s, "ICU", 19); // full
  const [p] = fill(s, "ED", 1, { acuity: 5 });
  enqueue(s, "ICU", p);
  const res = safety.evaluate(
    [
      prop("ICU", [
        { type: "accept_transfer", patientId: p.id, from: "ED" },
        { type: "open_overflow", beds: 2 },
        { type: "open_overflow", beds: 1 },
      ]),
      prop("Ward", [{ type: "open_overflow", beds: 3 }]),
      prop("ED", [{ type: "open_overflow", beds: 0 }]),
    ],
    s,
  );
  // Overflow is evaluated first, so the transfer fits into a new bed.
  const byType = res.entries.map((e) => [e.unit, e.action.type, e.action.beds ?? null, e.rule]);
  assert.deepEqual(byType, [
    ["ICU", "open_overflow", 2, null],
    ["ICU", "open_overflow", 1, safety.RULE_OVERFLOW_CAP],
    ["Ward", "open_overflow", 3, safety.RULE_OVERFLOW_CAP],
    ["ED", "open_overflow", 0, safety.RULE_OVERFLOW_CAP],
    ["ICU", "accept_transfer", null, null],
  ]);
  assert.equal(res.staffed.ICU, 21);
  assert.equal(res.after.ICU, 20);
});

// -- divert_ed ----------------------------------------------------------------------------------
test("divert_ed: allowed above 95% ED occupancy, blocked at or below it", () => {
  const cases = [
    [27, false], // 96.4%
    [26, true], // 92.9%
    [28, false],
  ];
  for (const [n, blocked] of cases) {
    const s = blankState();
    fill(s, "ED", n);
    const res = safety.evaluate([prop("ED", [{ type: "divert_ed" }])], s);
    assert.equal(res.entries[0].blocked, blocked, `${n}/28`);
    assert.equal(res.entries[0].rule, blocked ? safety.RULE_DIVERT_ED : null);
  }
  // exactly 95% is not above 95%
  const s = blankState();
  s.units.ED.bedsStaffed = 20;
  fill(s, "ED", 19);
  assert.equal(safety.evaluate([prop("ED", [{ type: "divert_ed" }])], s).entries[0].rule, safety.RULE_DIVERT_ED);
});

// -- divert_to --------------------------------------------------------------------------------------
function withCapacity(s, caps) {
  s.nearbyCapacity = Object.fromEntries(
    Object.entries(caps).map(([name, [icu, ward]]) => [
      name,
      { hospital: name, canAccept: { ICU: icu, Ward: ward }, validUntil: "12:00", conditionsPreferred: [], confidence: 0.85, note: "" },
    ]),
  );
}

test("divert_to requires a receiving hospital name", () => {
  const s = blankState();
  const [p] = fill(s, "ED", 1, { acuity: 4 });
  withCapacity(s, { "Rixdorf Hospital": [2, 2] });
  const res = safety.evaluate(
    [prop("ICU", [{ type: "divert_to", patientId: p.id }, { type: "divert_to", patientId: p.id, hospital: "Rixdorf Hospital" }])],
    s,
  );
  assert.deepEqual(rules(res), [safety.RULE_DIVERT_TO_NO_HOSPITAL, null]);
});

test("divert_to must name another hospital, not our own", () => {
  const s = blankState();
  const [p] = fill(s, "ED", 1, { acuity: 4 });
  withCapacity(s, { "Klinikum Kreuzberg": [5, 5], "Spreebogen Klinik": [1, 1] });
  const res = safety.evaluate(
    [
      prop("ICU", [
        { type: "divert_to", patientId: p.id, hospital: "Klinikum Kreuzberg" },
        { type: "divert_to", patientId: p.id, hospital: "Spreebogen Klinik" },
      ]),
    ],
    s,
  );
  assert.deepEqual(rules(res), [safety.RULE_DIVERT_TO_OWN, null]);
});

test("divert_to blocked when the receiving hospital reports zero capacity for the patient's unit", () => {
  const s = blankState();
  const [icuPatient] = fill(s, "ED", 1, { acuity: 4 });
  const [wardPatient, other] = fill(s, "ED", 2, { acuity: 3 });
  withCapacity(s, { "Rixdorf Hospital": [0, 3] });
  const res = safety.evaluate(
    [
      prop("ICU", [
        { type: "divert_to", patientId: icuPatient.id, hospital: "Rixdorf Hospital" }, // needs ICU: 0
        { type: "divert_to", patientId: wardPatient.id, hospital: "Rixdorf Hospital" }, // needs Ward: 3
        { type: "divert_to", patientId: other.id, hospital: "Unknown Clinic" },
      ]),
    ],
    s,
  );
  assert.deepEqual(rules(res), [safety.RULE_DIVERT_TO_CAPACITY, null, safety.RULE_DIVERT_TO_CAPACITY]);
  assert.equal(res.after.ED, 2); // the allowed divert leaves ED
});

test("divert capacity is counted cumulatively within one plan, across both passes", () => {
  const s = blankState();
  const [a, b, c] = fill(s, "ED", 3, { acuity: 5 });
  withCapacity(s, { "Rixdorf Hospital": [1, 0], "Spreebogen Klinik": [1, 0] });
  const first = safety.evaluate(
    [
      prop("ICU", [
        { type: "divert_to", patientId: a.id, hospital: "Rixdorf Hospital" },
        { type: "divert_to", patientId: b.id, hospital: "Rixdorf Hospital" },
      ]),
    ],
    s,
  );
  assert.deepEqual(rules(first), [null, safety.RULE_DIVERT_TO_CAPACITY]);
  assert.deepEqual(first.divertsUsed, { "Rixdorf Hospital": { ICU: 1 } });

  const second = safety.evaluate(
    [
      prop("ICU", [
        { type: "divert_to", patientId: c.id, hospital: "Rixdorf Hospital" },
        { type: "divert_to", patientId: c.id, hospital: "Spreebogen Klinik" },
      ]),
    ],
    s,
    { startingOccupied: first.after, divertsUsed: first.divertsUsed },
  );
  assert.deepEqual(rules(second), [safety.RULE_DIVERT_TO_CAPACITY, null]);
  assert.equal(second.after.ED, 1);
  assert.deepEqual(first.divertsUsed, { "Rixdorf Hospital": { ICU: 1 } }, "input map is not mutated");
});

test("unconstrained action types pass, and entries carry copies of the actions", () => {
  const s = blankState();
  const action = { type: "defer_transfer", patientId: "p001" };
  const res = safety.evaluate([prop("Ward", [action, { type: "request_beds", beds: 2 }, { type: "defer_elective" }])], s);
  assert.deepEqual(rules(res), [null, null, null]);
  res.entries[0].action.type = "changed";
  assert.equal(action.type, "defer_transfer");
});

// -- rule texts -------------------------------------------------------------------------------------
test("rule texts are distinct plain-language sentences, without code names or operators", () => {
  const names = Object.keys(safety).filter((k) => k.startsWith("RULE_"));
  assert.equal(names.length, 12);
  const texts = names.map((k) => safety[k]);
  assert.equal(new Set(texts).size, texts.length, "every rule reads differently");
  for (const [name, text] of names.map((k) => [k, safety[k]])) {
    assert.equal(typeof text, "string", name);
    assert.match(text, /^[A-Z].*\.$/, `${name} is a sentence`);
    assert.doesNotMatch(text, /\b[a-z]+_[a-z_]+\b/, `${name} names no action type or field`);
    assert.doesNotMatch(text, /[<>=]/, `${name} uses words, not operators`);
  }
});

// -- review fixes: malformed actions and one move per patient ----------------------------------------------
test("open_overflow: NaN, text or fractional bed counts are blocked", () => {
  const s = blankState();
  const res = safety.evaluate(
    [
      prop("Ward", [{ type: "open_overflow", beds: NaN }]),
      prop("ICU", [{ type: "open_overflow", beds: "2" }]),
      prop("ED", [{ type: "open_overflow", beds: 1.5 }]),
    ],
    s,
  );
  assert.deepEqual(rules(res), [safety.RULE_OVERFLOW_CAP, safety.RULE_OVERFLOW_CAP, safety.RULE_OVERFLOW_CAP]);
  assert.deepEqual(res.staffed, { ED: s.units.ED.bedsStaffed, ICU: s.units.ICU.bedsStaffed, Ward: s.units.Ward.bedsStaffed });
});

test("one move per patient per hour: accept + divert, two diverts, or divert + early discharge", () => {
  const s = blankState();
  fill(s, "ICU", 5);
  const [p, q] = fill(s, "ED", 2, { acuity: 4 });
  const [w] = fill(s, "Ward", 1, { acuity: 2, admitTick: 2, expectedDischargeTick: 14 });
  enqueue(s, "ICU", p);
  withCapacity(s, { "Rixdorf Hospital": [3, 3], "Spreebogen Klinik": [3, 3] });
  const res = safety.evaluate(
    [
      prop("ICU", [
        { type: "accept_transfer", patientId: p.id },
        { type: "divert_to", patientId: p.id, hospital: "Rixdorf Hospital" },
        { type: "divert_to", patientId: q.id, hospital: "Rixdorf Hospital" },
        { type: "divert_to", patientId: q.id, hospital: "Spreebogen Klinik" },
      ]),
      prop("Ward", [
        { type: "expedite_discharge", patientId: w.id, targetTick: 12 },
        { type: "divert_to", patientId: w.id, hospital: "Rixdorf Hospital" },
      ]),
    ],
    s,
  );
  assert.deepEqual(rules(res), [null, safety.RULE_ONE_MOVE, null, safety.RULE_ONE_MOVE, null, safety.RULE_ONE_MOVE]);
  assert.deepEqual(res.after, { ED: 0, ICU: 6, Ward: 1 }); // each patient counted once
  assert.deepEqual(res.divertsUsed, { "Rixdorf Hospital": { ICU: 1 } });
  assert.deepEqual(res.movedPatients.sort(), [p.id, q.id, w.id].sort());
  // The second pass (the Regional coordinator's diverts) continues from the first.
  const second = safety.evaluate([prop("ICU", [{ type: "divert_to", patientId: p.id, hospital: "Spreebogen Klinik" }])], s, {
    startingOccupied: res.after,
    divertsUsed: res.divertsUsed,
    movedPatients: res.movedPatients,
  });
  assert.deepEqual(rules(second), [safety.RULE_ONE_MOVE]);
});

test("divert_to needs a patient who is in the hospital; nothing is reserved otherwise", () => {
  const s = blankState();
  withCapacity(s, { "Spreebogen Klinik": [1, 1] });
  const res = safety.evaluate(
    [prop("ED", [{ type: "divert_to", hospital: "Spreebogen Klinik" }, { type: "divert_to", patientId: "p999", hospital: "Spreebogen Klinik" }])],
    s,
  );
  assert.deepEqual(rules(res), [safety.RULE_DIVERT_TO_PATIENT, safety.RULE_DIVERT_TO_PATIENT]);
  assert.deepEqual(res.divertsUsed, {});
});

test("expedite_discharge: NaN or fractional target, or a patient in another unit, is blocked", () => {
  const s = blankState(10);
  const [w1, w2] = fill(s, "Ward", 2, { acuity: 2, admitTick: 2, expectedDischargeTick: 14 });
  const [e] = fill(s, "ED", 1, { acuity: 2, admitTick: 2, expectedDischargeTick: 14 });
  const res = safety.evaluate(
    [
      prop("Ward", [
        { type: "expedite_discharge", patientId: w1.id, targetTick: NaN },
        { type: "expedite_discharge", patientId: w2.id, targetTick: 11.5 },
        { type: "expedite_discharge", patientId: e.id, targetTick: 12 },
      ]),
    ],
    s,
  );
  assert.deepEqual(rules(res), [safety.RULE_EXPEDITE_TARGET, safety.RULE_EXPEDITE_TARGET, safety.RULE_EXPEDITE_DISCHARGE]);
});

test("proposal shape: unknown unit, unknown action type, missing actions or bad action confidence", () => {
  const s = blankState();
  const res = safety.evaluate(
    [
      prop("OR", [{ type: "open_overflow", beds: 1 }]),
      prop("ED", [{ type: "nuke_everything" }]),
      { unit: "ED", author: "x", rationale: "x", confidence: 0.5 },
      prop("Ward", [{ type: "defer_elective", confidence: 5 }]),
      prop("ICU", [{ type: "defer_elective", confidence: 0.4 }]),
    ],
    s,
  );
  assert.deepEqual(rules(res), [safety.RULE_PROPOSAL_SHAPE, safety.RULE_PROPOSAL_SHAPE, safety.RULE_PROPOSAL_SHAPE, null]);
  assert.deepEqual(res.proposals.map((p) => [p.unit, p.actions.length]), [["ED", 0], ["ICU", 1]]);
});

test("accept_transfer: the allowed copy carries the queue's from-unit; the caller's action is untouched", () => {
  const s = blankState();
  const [p] = fill(s, "ED", 1, { acuity: 5 });
  enqueue(s, "ICU", p);
  const action = { type: "accept_transfer", patientId: p.id, from: "Ward" };
  const res = safety.evaluate([prop("ICU", [action])], s);
  assert.equal(res.proposals[0].actions[0].from, "ED");
  assert.equal(res.entries[0].action.from, "ED");
  assert.equal(action.from, "Ward");
});
