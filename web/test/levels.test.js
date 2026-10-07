// The level model (src/ui/levels.js): every level fills every field, with a legal basis for what
// it shares up, with peers and never; the UI shows level names, never level numbers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LEVEL_FIELDS, LEVEL_ORDER, LEVELS, levelsPanel } from "../src/ui/levels.js";

test("every level on the ladder is defined, and nothing else is", () => {
  assert.deepEqual(Object.keys(LEVELS).sort(), [...LEVEL_ORDER].sort());
});

for (const key of LEVEL_ORDER) {
  test(`level "${key}" has every field and a legal basis`, () => {
    const L = LEVELS[key];
    for (const f of LEVEL_FIELDS) assert.ok(typeof L[f] === "string" && L[f].trim().length > 0, `${key}.${f}`);
    for (const f of ["upBasis", "peersBasis", "neverBasis"]) assert.ok(L[f].length >= 4, `${key}.${f} is a real basis`);
    assert.ok(Array.isArray(L.kpis) && L.kpis.length >= 1 && L.kpis.length <= 5, `${key}.kpis: 1-5 tiles`);
  });
}

test("the panel names levels, never numbers, and marks the current one", () => {
  for (const key of LEVEL_ORDER) {
    const out = String(levelsPanel(key, { place: "Test" }));
    assert.doesNotMatch(out, /\bL[0-7]\b|Level [0-9]/, key);
    assert.match(out, new RegExp(`aria-current="step" class="is-here">${LEVELS[key].name.replace("·", "&middot;|·")}`));
    assert.match(out, /Never leaves/);
  }
});

test("an unknown level renders nothing", () => {
  assert.equal(levelsPanel("galaxy"), "");
});
