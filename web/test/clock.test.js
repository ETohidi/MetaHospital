import { test } from "node:test";
import assert from "node:assert/strict";
import { clock, dayClock, hourRange } from "../src/engine/clock.js";

test("clock starts at 08:00 and advances one hour per tick", () => {
  assert.equal(clock(0), "08:00");
  assert.equal(clock(1), "09:00");
  assert.equal(clock(7), "15:00");
  assert.equal(clock(15), "23:00");
});

test("clock rolls over at midnight and handles negative ticks", () => {
  assert.equal(clock(16), "00:00");
  assert.equal(clock(17), "01:00");
  assert.equal(clock(40), "00:00");
  assert.equal(clock(-1), "07:00");
  assert.equal(clock(-9), "23:00");
});

test("dayClock names the weekday, which advances past midnight", () => {
  assert.equal(dayClock(0), "Wednesday 08:00");
  assert.equal(dayClock(7), "Wednesday 15:00");
  assert.equal(dayClock(15), "Wednesday 23:00");
  assert.equal(dayClock(16), "Thursday 00:00");
  assert.equal(dayClock(16 + 24 * 4), "Monday 00:00");
  assert.equal(dayClock(16 + 24 * 6), "Wednesday 00:00");
  assert.equal(dayClock(-9), "Tuesday 23:00");
});

test("hourRange uses an en dash and wraps at midnight", () => {
  assert.equal(hourRange(4), "12:00–13:00");
  assert.equal(hourRange(7), "15:00–16:00");
  assert.equal(hourRange(15), "23:00–00:00");
});

// -- German time for any start moment -------------------------------------------------------
import { DEFAULT_START_MS, makeClock, startOfHour } from "../src/engine/clock.js";
import { Twin } from "../src/engine/twin.js";

const utc = (y, mo, d, h) => Date.UTC(y, mo - 1, d, h);

test("labels are German time in summer (UTC+2) and winter (UTC+1)", () => {
  assert.equal(makeClock(utc(2026, 7, 1, 10)).dayTime(0), "Wednesday 12:00");
  assert.equal(makeClock(utc(2026, 12, 1, 11)).dayTime(0), "Tuesday 12:00");
  assert.equal(makeClock(utc(2026, 12, 1, 11)).date(0), "1 Dec 2026");
  assert.equal(makeClock(DEFAULT_START_MS).date(0), "16 Sep 2026");
});

test("the clock follows the switch to winter time (02:00 happens twice) and back", () => {
  // 25 Oct 2026: 03:00 summer time becomes 02:00 winter time.
  const autumn = makeClock(utc(2026, 10, 24, 22)); // 00:00 German time
  assert.deepEqual([0, 1, 2, 3, 4].map(autumn.time), ["00:00", "01:00", "02:00", "02:00", "03:00"]);
  // 29 Mar 2026: 02:00 winter time becomes 03:00 summer time.
  const spring = makeClock(utc(2026, 3, 28, 23)); // 00:00 German time
  assert.deepEqual([0, 1, 2, 3].map(spring.time), ["00:00", "01:00", "03:00", "04:00"]);
});

test("dayIndex counts German calendar days from the start, and hour gives the hour of day", () => {
  const c = makeClock(utc(2026, 10, 13, 20)); // Tuesday 22:00 German time
  assert.equal(c.dayIndex(0), 0);
  assert.equal(c.dayIndex(1), 0); // 23:00
  assert.equal(c.dayIndex(2), 1); // 00:00 Wednesday
  assert.equal(c.dayIndex(-22), 0); // Tuesday 00:00
  assert.equal(c.dayIndex(-23), -1); // Monday 23:00: ticks before the start count backwards
  assert.equal(c.hour(2), 0);
});

test("startOfHour rounds down to the full hour", () => {
  assert.equal(startOfHour(utc(2026, 10, 13, 11) + 59 * 60_000 + 5_000), utc(2026, 10, 13, 11));
});

test("a twin's start moves only its clock labels: the same seed replays the same day", () => {
  const strip = (snap) => {
    // Everything except clock labels: times, dates, "valid until" and the plan's hour range.
    const { time, dayTime, hourRange, date, startMs, patients, nearbyCapacity, pendingBundle, ...rest } = snap;
    return {
      ...rest,
      patients: patients.map(({ expectedDischargeTime, ...p }) => p),
      nearbyCapacity: Object.values(nearbyCapacity).map(({ validUntil, ...c }) => c),
      pendingBundle: pendingBundle?.rows.map((r) => [r.patientId, r.actionType, r.confidence]),
    };
  };
  const a = new Twin();
  const b = new Twin({ startMs: utc(2026, 12, 24, 17) }); // Christmas Eve, 18:00 German time
  for (let i = 0; i < 6; i++) {
    a.decide(a.snapshot().pendingBundle.id, "approve");
    b.decide(b.snapshot().pendingBundle.id, "approve");
    a.tick();
    b.tick();
  }
  assert.deepEqual(strip(b.snapshot()), strip(a.snapshot()));
  assert.equal(a.snapshot().time, "18:00");
  assert.equal(b.snapshot().time, "04:00"); // 18:00 + 4 h warm-up/first plan + 6 h
  assert.equal(b.snapshot().dayTime, "Friday 04:00");
  assert.equal(b.snapshot().date, "25 Dec 2026");
  assert.match(b.log().at(-1).text, /^Started at 18:00 German time with \d+ patients\./);
  b.reset();
  assert.equal(b.snapshot().time, "22:00", "reset keeps the start moment");
});
