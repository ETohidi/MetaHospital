// The demo choreography (DEMO.md): first as it plays out with the default seed, then with
// occupancy set explicitly so the rules themselves never depend on how the dice fall.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SEED, Twin } from "../src/engine/twin.js";
import * as coordinator from "../src/engine/coordinator.js";
import * as planners from "../src/engine/planners.js";
import * as regional from "../src/engine/regional.js";
import { HOSPITAL_NAMES } from "../src/engine/state.js";
import { RULE_DIVERT_ED } from "../src/engine/safety.js";
import { ED_DIVERT_TICKS } from "../src/engine/sim.js";

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

function fill(s, unit, n) {
  return Array.from({ length: n }, () =>
    s.addPatient({ unit, acuity: 2, condition: "trauma", admitTick: s.tick - 3, expectedDischargeTick: s.tick + 50 }),
  );
}

/** One planning round exactly as Twin.tick() does it, minus the simulation step. */
function plan(t) {
  const s = t.state;
  const proposals = ["ED", "ICU", "Ward"].map((u) => planners.generate(u, s));
  const capacity = Object.fromEntries(HOSPITAL_NAMES.map((name) => [name, regional.generate(name, s)]));
  return coordinator.buildBundle(s, proposals, capacity);
}

const edDivert = (bundle) => bundle.safety.find((e) => e.unit === "ED" && e.action.type === "divert_ed");
const blockedLine = `blocked ED planner's "divert ambulances": ${RULE_DIVERT_ED}`;
const edProposal = (bundle) => bundle.proposals.find((p) => p.unit === "ED");

// -- with the default seed -------------------------------------------------------------------------
test("demo: the default-seed day, from the first plan to the charge nurse's nearby-hospital hint", () => {
  const t = new Twin();
  assert.equal(t.seed, DEFAULT_SEED);
  assert.equal(DEFAULT_SEED, 20260926);

  // Step 1: 12:00, a first plan with real work in it. Approve it.
  let snap = t.snapshot();
  assert.equal(snap.time, "12:00");
  let b = snap.pendingBundle;
  assert.ok(b, "a plan is waiting");
  assert.ok(b.rows.length >= 2, `first plan has ${b.rows.length} rows`);
  t.decide(b.id, "approve");

  // Step 2: the bus accident. ED is now over 95% full, so ED's divert is allowed, and the
  // Regional coordinator offers ICU patients to a neighbour.
  assert.deepEqual(t.surge(), { surge: "bus accident, 20 casualties" });
  assert.ok(t.log().some((l) => l.actor === "Simulation" && l.level === "warn" && l.text === "Emergency scenario: bus accident, 20 casualties (+20 ED arrivals)"));
  b = t.tick();
  snap = t.snapshot();
  assert.ok(snap.units.ED.bedsOccupied / snap.units.ED.bedsStaffed > 0.95);
  let divert = edDivert(b);
  assert.equal(divert.author, "ED planner");
  assert.equal(divert.blocked, false);
  assert.equal(divert.action.confidence, 0.85);
  assert.equal(b.rows.find((r) => r.unit === "ED").movement, "diverted");
  const toNeighbours = b.rows.filter((r) => r.author === "Regional coordinator" && r.actionType === "divert_to");
  assert.ok(toNeighbours.length >= 1, "at least one ICU patient offered to a neighbour");
  assert.ok(toNeighbours.every((r) => r.unit === "ICU" && r.acuity >= 4));
  // A surge makes our own hospital hold back harder when answering the Regional coordinator.
  const own = b.nearbyCapacity.find((c) => c.hospital === "Klinikum Kreuzberg");
  assert.equal(own.confidence, 0.5);
  assert.match(own.note, /bus accident, 20 casualties in progress here too\.$/);

  t.decide(b.id, "approve");
  assert.equal(t.snapshot().edDivertHoursRemaining, ED_DIVERT_TICKS);
  const family = t.family().map((m) => m.text);
  assert.ok(family.includes("The Emergency Department is temporarily diverting incoming ambulances. Confidence: high."));
  for (const r of toNeighbours) assert.ok(family.some((m) => m.startsWith(`Patient ${r.patientId} is being transferred to `)));

  // Step 3: an hour later the diversion still runs but ED is no longer over 95%. ED asks to
  // keep diverting; the safety check blocks it.
  b = t.tick();
  snap = t.snapshot();
  assert.ok(snap.edDivertHoursRemaining > 0);
  assert.ok(snap.units.ED.bedsOccupied / snap.units.ED.bedsStaffed <= 0.95);
  divert = edDivert(b);
  assert.equal(divert.blocked, true);
  assert.equal(divert.rule, RULE_DIVERT_ED);
  assert.equal(divert.action.confidence, 0.55);
  assert.match(edProposal(b).rationale, /^Ambulances are still diverted and ED is at \d+% of usable beds; asking to keep diverting/);
  assert.ok(!b.rows.some((r) => r.unit === "ED"), "the blocked ask is not in the plan table");
  assert.ok(t.log().some((l) => l.actor === "Safety check" && l.level === "block" && l.text === blockedLine));

  // The charge nurse rejects; ED hears it although its only ask was blocked.
  t.decide(b.id, "reject", "Wrong priority order");
  assert.equal(t.log()[0].text, `rejected the ${b.hourRange} plan: Wrong priority order`);
  assert.deepEqual(t.snapshot().units.ED.recentRejections, ["Wrong priority order"]);

  // Step 4: next hour ED does not ask to divert, and says why.
  b = t.tick();
  assert.equal(edDivert(b), undefined);
  assert.ok(edProposal(b).rationale.includes("(Noting recent rejection: Wrong priority order)"), edProposal(b).rationale);

  // Step 5: at the next plan that asks something for ICU, the charge nurse rejects it,
  // pointing at the nearby hospitals. ICU hears it and gets the hint.
  for (let i = 0; i < 6 && !b.safety.some((e) => e.unit === "ICU"); i++) {
    t.decide(b.id, "approve");
    b = t.tick();
  }
  assert.ok(b.safety.some((e) => e.unit === "ICU"), "a plan asks something for ICU within 6 hours");
  assert.equal(t.census("ICU").hint, null);
  t.decide(b.id, "reject", "A nearby hospital should take this patient");
  const hint = t.census("ICU").hint;
  assert.ok(hint);
  assert.match(hint, /nearby hospital could take this patient/);
});

// -- with explicit occupancy --------------------------------------------------------------------------
test("demo: divert allowed above 95%, the request to keep diverting blocked below it, then ED backs off", () => {
  const t = blankTwin();
  const s = t.state;
  const ed = fill(s, "ED", 27); // 96% of 28 usable beds
  fill(s, "ICU", 12);
  fill(s, "Ward", 40);

  // Right after the emergency ED is over 95%: the divert is appropriate.
  let b = plan(t);
  let d = edDivert(b);
  assert.equal(d.blocked, false);
  assert.equal(d.author, "ED planner");
  const edRow = b.rows.find((r) => r.unit === "ED");
  assert.equal(edRow.movement, "diverted");
  assert.equal(edRow.confidence, 0.85);
  assert.equal(edRow.reason, "ED at 96% of usable beds; the whole unit is full, not one patient.");
  t.decide(b.id, "approve");
  assert.equal(t.family()[0].text, "The Emergency Department is temporarily diverting incoming ambulances. Confidence: high.");
  assert.equal(s.edDivertTicksRemaining, ED_DIVERT_TICKS);

  // An hour later ED is at 79% and the diversion still runs: ED asks to keep diverting.
  for (const p of ed.slice(0, 5)) s.removePatient(p.id);
  s.tick += 1;
  s.edDivertTicksRemaining -= 1;
  b = plan(t);
  d = edDivert(b);
  assert.equal(d.blocked, true);
  assert.equal(d.rule, RULE_DIVERT_ED);
  assert.equal(d.action.confidence, 0.55);
  assert.ok(!b.rows.some((r) => r.unit === "ED"), "the blocked action is not in the plan table");
  assert.ok(t.log().some((l) => l.actor === "Safety check" && l.level === "block" && l.text === blockedLine));
  assert.ok(
    t.log().some(
      (l) =>
        l.actor === "ED planner" &&
        l.text ===
          `proposed 1 action: Ambulances are still diverted and ED is at 79% of usable beds; asking to keep diverting for another ${ED_DIVERT_TICKS} hours.`,
    ),
  );

  // The charge nurse rejects; the reason goes back to ED.
  t.decide(b.id, "reject", "Wrong priority order");
  assert.equal(t.log()[0].text, `rejected the ${b.hourRange} plan: Wrong priority order`);

  // Next hour ED is at 93%: it references the rejection and asks for beds instead.
  fill(s, "ED", 4);
  s.tick += 1;
  b = plan(t);
  assert.equal(edDivert(b), undefined);
  const ask = edProposal(b);
  assert.equal(ask.actions[0].type, "request_beds");
  assert.equal(
    ask.rationale,
    "ED under pressure; requesting beds from downstream units. (Noting recent rejection: Wrong priority order)",
  );
});

test("demo: the edges of the 90% preview band and the 95% threshold", () => {
  const cases = [
    // [ED patients, usable ED beds, expected divert_ed outcome]
    [25, 28, "none"], // 89%
    [26, 28, "blocked"], // 93%
    [27, 28, "allowed"], // 96%
    [28, 28, "allowed"], // 100%
    [18, 20, "none"], // exactly 90% is not above 90%
    [19, 20, "blocked"], // exactly 95% is not above 95%
    [20, 20, "allowed"], // 100%
  ];
  for (const [n, staffed, expected] of cases) {
    const t = blankTwin();
    t.state.units.ED.bedsStaffed = staffed;
    fill(t.state, "ED", n);
    const d = edDivert(plan(t));
    const got = d ? (d.blocked ? "blocked" : "allowed") : "none";
    assert.equal(got, expected, `${n}/${staffed} ED patients`);
    if (d) {
      assert.equal(d.action.confidence, expected === "allowed" ? 0.85 : 0.6, `${n}/${staffed}`);
      assert.equal(d.rule, expected === "blocked" ? RULE_DIVERT_ED : null);
    }
  }
  assert.equal(planners.ED_DIVERT_PREVIEW_THRESHOLD, 0.9);
});
