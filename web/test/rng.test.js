import { test } from "node:test";
import assert from "node:assert/strict";
import { createRng, hashFloat } from "../src/engine/rng.js";

test("same seed gives the same sequence, different seeds differ", () => {
  const a = createRng(42);
  const b = createRng(42);
  const c = createRng(43);
  const seqA = Array.from({ length: 20 }, () => a.random());
  const seqB = Array.from({ length: 20 }, () => b.random());
  const seqC = Array.from({ length: 20 }, () => c.random());
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, seqC);
  for (const x of seqA) assert.ok(x >= 0 && x < 1);
});

test("randint is inclusive and covers the range", () => {
  const rng = createRng(1);
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const n = rng.randint(1, 6);
    assert.ok(Number.isInteger(n) && n >= 1 && n <= 6);
    seen.add(n);
  }
  assert.equal(seen.size, 6);
});

test("uniform stays within bounds", () => {
  const rng = createRng(2);
  for (let i = 0; i < 1000; i++) {
    const x = rng.uniform(0.1, 0.3);
    assert.ok(x >= 0.1 && x < 0.3);
  }
});

test("choice picks elements of the array", () => {
  const rng = createRng(3);
  const arr = ["a", "b", "c"];
  const seen = new Set();
  for (let i = 0; i < 300; i++) seen.add(rng.choice(arr));
  assert.deepEqual([...seen].sort(), arr);
});

test("choices follows the weights and returns numeric keys as numbers", () => {
  const rng = createRng(4);
  const counts = { 3: 0, 4: 0, 5: 0 };
  const n = 20000;
  for (let i = 0; i < n; i++) {
    const k = rng.choices({ 3: 0.2, 4: 0.5, 5: 0.3 });
    assert.equal(typeof k, "number");
    counts[k] += 1;
  }
  assert.ok(Math.abs(counts[3] / n - 0.2) < 0.02);
  assert.ok(Math.abs(counts[4] / n - 0.5) < 0.02);
  assert.ok(Math.abs(counts[5] / n - 0.3) < 0.02);
  assert.equal(typeof rng.choices({ x: 1 }), "string");
});

test("sample returns k distinct elements", () => {
  const rng = createRng(5);
  const pop = ["trauma", "cardiac", "respiratory", "stroke", "infection", "other"];
  for (let i = 0; i < 200; i++) {
    const s = rng.sample(pop, 2);
    assert.equal(s.length, 2);
    assert.notEqual(s[0], s[1]);
    for (const x of s) assert.ok(pop.includes(x));
  }
  assert.throws(() => rng.sample(pop, 7));
});

test("lognormvariate has roughly the right median and is positive", () => {
  const rng = createRng(6);
  const xs = Array.from({ length: 20001 }, () => rng.lognormvariate(Math.log(6.5), 0.4)).sort((a, b) => a - b);
  assert.ok(xs[0] > 0);
  const median = xs[10000];
  assert.ok(Math.abs(median - 6.5) < 0.2, `median ${median}`);
});

test("poisson has the right mean and handles mean <= 0", () => {
  const rng = createRng(7);
  const n = 20000;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const k = rng.poisson(6);
    assert.ok(Number.isInteger(k) && k >= 0);
    sum += k;
  }
  assert.ok(Math.abs(sum / n - 6) < 0.1, `mean ${sum / n}`);
  assert.equal(rng.poisson(0), 0);
  assert.equal(rng.poisson(-1), 0);
});

test("hashFloat is stable and in [0, 1)", () => {
  assert.equal(hashFloat(1, 2, "Rixdorf Hospital", "ICU"), hashFloat(1, 2, "Rixdorf Hospital", "ICU"));
  assert.notEqual(hashFloat(1, 2, "Rixdorf Hospital", "ICU"), hashFloat(1, 3, "Rixdorf Hospital", "ICU"));
  for (let i = 0; i < 100; i++) {
    const x = hashFloat(i, "x");
    assert.ok(x >= 0 && x < 1);
  }
});
