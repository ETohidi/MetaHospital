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
