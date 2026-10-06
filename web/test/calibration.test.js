// Calibration of the hospital simulation (sim.js): on a day where the charge nurse approves
// every plan, the own hospital should stay near its seeded occupancy (08:00: ED 79%,
// ICU 89%, Ward 89%) instead of draining or overflowing.
//
// Measured 2026-09-30, seeds 1-20, 24 hours, every plan approved, no emergency. Utilisation
// is occupied / usable beds from the unit history rows of hours 4-24 (after the 3 replayed
// warmup hours), i.e. the occupancy each plan is made from:
//   pooled mean       ED 65.2%   ICU 74.3%   Ward 78.8%
//   per-seed means    ED 55.4-74.5%   ICU 64.2-87.2%   Ward 70.6-92.8%
// (Right after each approval, once waiting patients have moved upstairs: ED 54.8%,
// ICU 80.5%, Ward 80.8%.)
// The bands below are the target bands (ED 45-80%, ICU 65-95%, Ward 65-92%) tightened to
// about 10 points around what was measured. Re-measure if you change the constants below.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SEED, Twin } from "../src/engine/twin.js";
import * as sim from "../src/engine/sim.js";

const UNITS = ["ED", "ICU", "Ward"];
const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);
const HOURS = 24;
const FROM_HOUR = 4;
const BANDS = { ED: [0.55, 0.75], ICU: [0.65, 0.85], Ward: [0.7, 0.88] };
const PER_SEED_BAND = [0.45, 1.0]; // no single day drains or ends up over capacity on average

/** Utilisation samples (hours FROM_HOUR..HOURS) of one day where every plan is approved. */
function approvingDay(seed) {
  const t = new Twin({ seed });
  while (t.state.tick < HOURS) {
    const pending = t.inbox()[0];
    if (pending) t.decide(pending.id, "approve");
    t.tick();
  }
  return Object.fromEntries(
    UNITS.map((u) => [u, t.unitHistory(u).history.filter((r) => r.tick >= FROM_HOUR).map((r) => r.inUse / r.usable)]),
  );
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const pct = (x) => `${(x * 100).toFixed(1)}%`;

test("calibration: the constants the bands were measured with", () => {
  assert.deepEqual(sim.LOS_RANGES.ED, [2, 6]);
  assert.deepEqual(sim.ARRIVAL_MEANS, { ED: 7, ICU: 1, Ward: 6 });
  assert.equal(sim.ICU_ADMIT_MIN_ACUITY, 4);
  assert.equal(sim.WARD_ADMIT_MIN_ACUITY, 3);
  assert.equal(sim.MAX_BOARDING_TICKS, 6);
});

test("calibration: approving every plan keeps utilisation near the seeded level (20 seeds, 24 hours)", () => {
  const pooled = { ED: [], ICU: [], Ward: [] };
  for (const seed of SEEDS) {
    const day = approvingDay(seed);
    for (const u of UNITS) {
      assert.equal(day[u].length, HOURS - FROM_HOUR + 1, `seed ${seed} ${u}: one sample per hour`);
      const m = mean(day[u]);
      assert.ok(m >= PER_SEED_BAND[0] && m <= PER_SEED_BAND[1], `seed ${seed} ${u}: ${pct(m)}`);
      pooled[u].push(...day[u]);
    }
  }
  for (const u of UNITS) {
    const m = mean(pooled[u]);
    const [lo, hi] = BANDS[u];
    assert.ok(m >= lo && m <= hi, `${u} mean utilisation ${pct(m)} outside ${pct(lo)}-${pct(hi)}`);
  }
});

// The 6-hour projection on an approving day. Measured 2026-09-30, default seed and seeds 1-7,
// 18 approved hours, projection made each hour vs the ICU occupancy 6 hours later: mean
// error ICU +0.3 (per seed -3.8..+3.5), Ward -2.0, ED +4.6. Before transfers were counted
// the ICU line dived (mean -5.1) and ED boarders never left (mean +9.7).
test("calibration: the 6-hour ICU projection tracks the actual occupancy on an approving day", () => {
  const errors = [];
  for (const seed of [DEFAULT_SEED, 1, 2, 3, 4, 5, 6, 7]) {
    const t = new Twin({ seed });
    const projected = [];
    const actual = [];
    for (let h = 0; h < 18; h++) {
      projected.push(t.unitHistory("ICU").projection.at(-1).projectedInUse);
      actual.push(t.snapshot().units.ICU.bedsOccupied);
      t.decide(t.inbox()[0].id, "approve");
      t.tick();
    }
    for (let h = 0; h + 6 < 18; h++) errors.push(projected[h] - actual[h + 6]);
  }
  const m = mean(errors);
  assert.ok(Math.abs(m) <= 4, `ICU projection off by ${m.toFixed(2)} beds on average`);
});
