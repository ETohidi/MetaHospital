import { test } from "node:test";
import assert from "node:assert/strict";
import { createRng } from "../src/engine/rng.js";
import { TwinState } from "../src/engine/state.js";
import * as coordinator from "../src/engine/coordinator.js";
import * as planners from "../src/engine/planners.js";
import { RULE_DIVERT_ED, RULE_DIVERT_TO_CAPACITY, RULE_STAFFED_CAP } from "../src/engine/safety.js";
import { ACTION_LABEL, actionLabel } from "../src/engine/labels.js";

// -- fixtures ----------------------------------------------------------------------------
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

function cap(hospital, icu, ward, confidence = 0.85, conditionsPreferred = []) {
  return { hospital, canAccept: { ICU: icu, Ward: ward }, validUntil: "12:00", conditionsPreferred, confidence, note: "test" };
}

function caps(...list) {
  return Object.fromEntries(list.map((c) => [c.hospital, c]));
}

const OWN = "Klinikum Kreuzberg";
const SPREE = "Spreebogen Klinik";
const RIX = "Rixdorf Hospital";

function planWithRealPlanners(s, capacity) {
  const proposals = ["ED", "ICU", "Ward"].map((u) => planners.generate(u, s));
  return coordinator.buildBundle(s, proposals, capacity);
}

const diverts = (bundle) => bundle.rows.filter((r) => r.actionType === "divert_to");

// -- conflicts -------------------------------------------------------------------------------
test("conflict: two units claim one patient -> the unit fitting the acuity keeps it", () => {
  const s = blankState();
  const [sick] = fill(s, "ED", 1, { acuity: 4 });
  const [mid] = fill(s, "ED", 1, { acuity: 3 });
  const [mild] = fill(s, "ED", 1, { acuity: 1 });
  const claim = (id) => ({ type: "accept_transfer", patientId: id, from: "ED" });
  const proposals = [
    { unit: "Ward", author: "Ward planner", actions: [claim(sick.id), claim(mid.id), claim(mild.id)], rationale: "r", confidence: 0.6, risks: [] },
    { unit: "ICU", author: "ICU planner", actions: [claim(sick.id), claim(mid.id), claim(mild.id)], rationale: "r", confidence: 0.7, risks: [] },
  ];
  const resolved = coordinator.resolveConflicts(s, proposals);
  assert.deepEqual(resolved[0].actions.map((a) => a.patientId), [mid.id, mild.id]); // Ward keeps acuity 3, and acuity 1 (first claim)
  assert.deepEqual(resolved[1].actions.map((a) => a.patientId), [sick.id]);
  assert.equal(proposals[0].actions.length, 3, "input not mutated");
  const texts = s.log.filter((l) => l.actor === "Coordinator").map((l) => l.text);
  assert.ok(texts.includes(`conflict: patient ${sick.id} claimed by multiple units; kept ICU, dropped Ward`));
  assert.ok(texts.includes(`conflict: patient ${mid.id} claimed by multiple units; kept Ward, dropped ICU`));
});

// -- bundle shape ----------------------------------------------------------------------------
test("buildBundle: plan rows, summary, before/after and capacity answers", () => {
  const s = blankState(4);
  fill(s, "ICU", 10);
  const p = waitFor(s, "ICU", { acuity: 5, condition: "stroke" });
  const b = planWithRealPlanners(s, caps(cap(OWN, 5, 5), cap(SPREE, 2, 3), cap(RIX, 0, 1, 0.4)));
  assert.equal(b.id, 1);
  assert.equal(b.hourRange, "12:00–13:00");
  assert.equal(b.status, "pending");
  assert.equal(b.decidedTime, null);
  assert.equal(b.summary, "12:00–13:00: 1/1 actions cleared by the Safety check");
  assert.deepEqual(b.rows, [
    {
      unit: "ICU",
      author: "ICU planner",
      patientId: p.id,
      condition: "stroke",
      acuity: 5,
      movement: "ED → ICU",
      actionType: "accept_transfer",
      confidence: 0.75,
      reason: "stroke patient, acuity 5; ICU bed available.",
    },
  ]);
  assert.equal(b.overallConfidence, 0.75);
  assert.deepEqual(b.before, { ED: 1, ICU: 10, Ward: 0 });
  assert.deepEqual(b.after, { ED: 0, ICU: 11, Ward: 0 });
  assert.deepEqual(b.nearbyCapacity.map((c) => c.hospital), [OWN, SPREE, RIX]);
  assert.equal(s.nextBundleId, 2);
  assert.equal(s.log.at(-1).text, b.summary);
  assert.equal(s.log.at(-1).actor, "Coordinator");
});

// -- nearby capacity is recorded first -----------------------------------------------------------
test("this hour's nearby capacity is recorded before the safety check runs", () => {
  const s = blankState();
  const p = fill(s, "ED", 1, { acuity: 4 })[0];
  assert.deepEqual(s.nearbyCapacity, {});
  const proposals = [
    { unit: "ED", author: "ED planner", actions: [{ type: "divert_ed" }], rationale: "r", confidence: 0.6, risks: [] },
    {
      unit: "ICU",
      author: "ICU planner",
      actions: [{ type: "divert_to", patientId: p.id, hospital: RIX, confidence: 0.8 }],
      rationale: "r",
      confidence: 0.8,
      risks: [],
    },
  ];
  const b = coordinator.buildBundle(s, proposals, caps(cap(OWN, 0, 0), cap(RIX, 1, 1)));
  const divert = b.safety.find((e) => e.action.type === "divert_to");
  assert.equal(divert.blocked, false, "checked against this hour's answer, not last hour's");
  assert.equal(s.nearbyCapacity[RIX].canAccept.ICU, 1);

  const actors = s.log.map((l) => l.actor);
  const capacityLog = actors.indexOf(RIX);
  const safetyLog = actors.indexOf("Safety check");
  assert.ok(capacityLog >= 0 && safetyLog > capacityLog, "capacity logged before safety blocks");
  assert.equal(s.log[safetyLog].text, `blocked ED planner's "divert ambulances": ${RULE_DIVERT_ED}`);
  assert.equal(s.log[safetyLog].level, "block");
  assert.equal(
    s.log[capacityLog].text,
    "can accept 1 ICU / 1 Ward until 12:00 (confidence 0.85). test",
  );
});

// -- regional diverts ----------------------------------------------------------------------------
test("no divert while the local ICU still has free beds this hour", () => {
  const s = blankState();
  fill(s, "ICU", 10);
  for (let i = 0; i < 3; i++) waitFor(s, "ICU", { acuity: 4 });
  const b = planWithRealPlanners(s, caps(cap(OWN, 0, 0), cap(SPREE, 5, 5), cap(RIX, 5, 5)));
  assert.equal(diverts(b).length, 0);
  assert.ok(!b.proposals.some((p) => p.author === "Regional coordinator"));
});

test("diverts only the patients beyond local free beds, sickest and longest-waiting first", () => {
  const setup = (icuOccupied) => {
    const s = blankState();
    fill(s, "ICU", icuOccupied);
    const a = waitFor(s, "ICU", { acuity: 5, waitingTicks: 1 });
    const b = waitFor(s, "ICU", { acuity: 4, waitingTicks: 5 });
    const c = waitFor(s, "ICU", { acuity: 4, waitingTicks: 2 });
    const d = waitFor(s, "ICU", { acuity: 5, waitingTicks: 3 });
    waitFor(s, "ICU", { acuity: 3, waitingTicks: 9 }); // below the divert threshold
    return { s, a, b, c, d };
  };

  const accepted = (bundle) => bundle.rows.filter((r) => r.actionType === "accept_transfer").map((r) => r.patientId);

  // ICU 18/19: the ICU planner takes the sickest (d: acuity 5, waited longest) -> no bed left.
  let { s, a, b, c, d } = setup(18);
  let bundle = planWithRealPlanners(s, caps(cap(OWN, 0, 0), cap(RIX, 5, 5)));
  assert.deepEqual(accepted(bundle), [d.id]);
  assert.deepEqual(diverts(bundle).map((r) => r.patientId), [a.id, b.id, c.id]);

  // ICU 16/19: the planner fills all 3 free beds (d, a, b); only c is diverted.
  ({ s, a, b, c, d } = setup(16));
  bundle = planWithRealPlanners(s, caps(cap(OWN, 0, 0), cap(RIX, 5, 5)));
  assert.deepEqual(accepted(bundle), [d.id, a.id, b.id]);
  assert.deepEqual(diverts(bundle).map((r) => r.patientId), [c.id]);
  assert.deepEqual(bundle.after, { ED: 1, ICU: 19, Ward: 0 });

  // ICU 16/19 but a hand-made ICU proposal takes only a: the 2 beds still free go to the
  // next sickest (d, then b), and only c is diverted.
  ({ s, a, b, c, d } = setup(16));
  const icuTakesA = {
    unit: "ICU",
    author: "ICU planner",
    actions: [{ type: "accept_transfer", patientId: a.id, from: "ED" }],
    rationale: "r",
    confidence: 0.7,
    risks: [],
  };
  bundle = coordinator.buildBundle(s, [icuTakesA], caps(cap(OWN, 0, 0), cap(RIX, 5, 5)));
  assert.deepEqual(diverts(bundle).map((r) => r.patientId), [c.id]);
  assert.deepEqual(bundle.after, { ED: 3, ICU: 17, Ward: 0 });
});

test("the ICU planner's transfers fill exactly the free beds, so the safety check never refuses one", () => {
  const s = blankState();
  fill(s, "ICU", 15); // 4 of 19 free
  for (let i = 0; i < 7; i++) waitFor(s, "ICU", { acuity: 4 + (i % 2), waitingTicks: i });
  const bundle = planWithRealPlanners(s, caps(cap(OWN, 0, 0), cap(RIX, 5, 5)));
  const asks = bundle.safety.filter((e) => e.author === "ICU planner");
  assert.equal(asks.length, 4);
  assert.ok(asks.every((e) => !e.blocked && e.rule !== RULE_STAFFED_CAP));
  assert.equal(bundle.after.ICU, 19);
  assert.equal(diverts(bundle).length, 3, "the other 3 are offered to a neighbour");
});

test("prefers a neighbour whose preferred conditions match, then the highest confidence", () => {
  const s = blankState();
  fill(s, "ICU", 19); // full: ICU planner holds
  const cardiac = waitFor(s, "ICU", { acuity: 5, condition: "cardiac", waitingTicks: 3 });
  const infection = waitFor(s, "ICU", { acuity: 4, condition: "infection", waitingTicks: 2 });
  const capacity = caps(
    cap(OWN, 9, 9, 0.99, ["cardiac", "infection"]), // never our own hospital
    cap(SPREE, 3, 3, 0.85, ["cardiac", "stroke"]),
    cap(RIX, 3, 3, 0.9, ["trauma", "other"]),
  );
  const bundle = planWithRealPlanners(s, capacity);
  const rows = diverts(bundle);
  assert.deepEqual(
    rows.map((r) => [r.patientId, r.movement]),
    [
      [cardiac.id, `→ ${SPREE}`],
      [infection.id, `→ ${RIX}`],
    ],
  );
  assert.equal(rows[0].author, "Regional coordinator");
  assert.equal(rows[0].unit, "ICU");
  assert.equal(rows[0].reason, `ICU has no free bed this hour; ${SPREE} can accept (confidence 0.85).`);
  assert.equal(rows[1].reason, `ICU has no free bed this hour; ${RIX} can accept (confidence 0.90).`);

  const proposal = bundle.proposals.find((p) => p.author === "Regional coordinator");
  assert.equal(proposal.unit, "ICU");
  assert.equal(proposal.confidence, 0.85);
  assert.ok(bundle.safety.filter((e) => e.action.type === "divert_to").every((e) => !e.blocked));
});

test("a neighbour's slots are used up within the hour; no room anywhere means no divert", () => {
  let s = blankState();
  fill(s, "ICU", 19);
  const first = waitFor(s, "ICU", { acuity: 5, condition: "infection", waitingTicks: 4 });
  const second = waitFor(s, "ICU", { acuity: 5, condition: "infection", waitingTicks: 1 });
  let bundle = planWithRealPlanners(s, caps(cap(OWN, 0, 0), cap(SPREE, 1, 0, 0.5), cap(RIX, 1, 0, 0.9)));
  assert.deepEqual(
    diverts(bundle).map((r) => [r.patientId, r.movement]),
    [
      [first.id, `→ ${RIX}`],
      [second.id, `→ ${SPREE}`],
    ],
  );

  s = blankState();
  fill(s, "ICU", 19);
  waitFor(s, "ICU", { acuity: 5 });
  bundle = planWithRealPlanners(s, caps(cap(OWN, 4, 4), cap(SPREE, 0, 2), cap(RIX, 0, 2)));
  assert.equal(diverts(bundle).length, 0);
});

// -- plan expiry ------------------------------------------------------------------------------------
test("expirePending marks a waiting plan expired with the current time", () => {
  const s = blankState(4);
  const b1 = planWithRealPlanners(s, caps(cap(OWN, 0, 0)));
  s.tick = 5;
  const b2 = planWithRealPlanners(s, caps(cap(OWN, 0, 0)));
  assert.equal(b1.status, "expired");
  assert.equal(b1.decidedTime, "13:00");
  assert.equal(b2.status, "pending");
  assert.ok(s.log.some((l) => l.actor === "Coordinator" && l.text === "12:00–13:00 plan expired without a decision"));
  assert.equal(s.bundles.filter((b) => b.status === "pending").length, 1);
});

// -- log lines -------------------------------------------------------------------------------------
test("log: planner lines count the actions in words, or give just the rationale when there are none", () => {
  const s = blankState();
  const p = fill(s, "ED", 1, { acuity: 4 })[0];
  const proposals = [
    { unit: "ED", author: "ED planner", actions: [], rationale: "ED occupancy within normal range; no action needed.", confidence: 0.6, risks: [] },
    { unit: "ICU", author: "ICU planner", actions: [{ type: "defer_elective" }], rationale: "One thing.", confidence: 0.6, risks: [] },
    {
      unit: "Ward",
      author: "Ward planner",
      actions: [{ type: "defer_elective" }, { type: "request_beds", beds: 1 }],
      rationale: "Two things.",
      confidence: 0.6,
      risks: [],
    },
    {
      unit: "ICU",
      author: "Regional coordinator",
      actions: [{ type: "divert_to", patientId: p.id, hospital: SPREE, confidence: 0.8 }],
      rationale: "Divert.",
      confidence: 0.8,
      risks: [],
    },
  ];
  coordinator.buildBundle(s, proposals, caps(cap(OWN, 0, 0), cap(SPREE, 0, 3)));
  const lines = (actor) => s.log.filter((l) => l.actor === actor).map((l) => l.text);
  assert.deepEqual(lines("ED planner"), ["ED occupancy within normal range; no action needed."]);
  assert.deepEqual(lines("ICU planner"), ["proposed 1 action: One thing."]);
  assert.deepEqual(lines("Ward planner"), ["proposed 2 actions: Two things."]);
  assert.deepEqual(lines("Safety check"), [`blocked Regional coordinator's "send to another hospital": ${RULE_DIVERT_TO_CAPACITY}`]);
});

test("labels: every action type has a plain-language label; unknown types fall back to the type", () => {
  const types = [
    "accept_transfer",
    "defer_transfer",
    "expedite_discharge",
    "open_overflow",
    "request_beds",
    "divert_ed",
    "defer_elective",
    "divert_to",
  ];
  assert.deepEqual(Object.keys(ACTION_LABEL).sort(), [...types].sort());
  for (const type of types) {
    assert.equal(actionLabel(type), ACTION_LABEL[type]);
    assert.doesNotMatch(actionLabel(type), /_/, type);
  }
  assert.equal(actionLabel("divert_ed"), "divert ambulances");
  assert.equal(actionLabel("teleport"), "teleport");
});

test("buildBundle: a proposal without an actions list proposes nothing instead of crashing", () => {
  const s = blankState(4);
  const b = coordinator.buildBundle(
    s,
    [{ unit: "ED", author: "ED planner", rationale: "nothing to do", confidence: 0.5 }],
    caps(cap(OWN, 0, 0)),
  );
  assert.deepEqual(b.rows, []);
  assert.equal(b.summary, `${b.hourRange}: no actions this hour`);
  assert.ok(s.log.some((l) => l.actor === "ED planner" && l.text === "nothing to do"));
});
