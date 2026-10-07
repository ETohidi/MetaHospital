// The real-data pipeline (tools/build-data.mjs): CSV and World Bank parsers, roll-up sums, the
// committed snapshot in web/data, and the Germany page's reading of it (maps.js normalizeDE).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDE,
  buildWorld,
  latestByCountry,
  MAX_BYTES,
  parseCsv,
  rollUp,
  SERIES_DAYS,
} from "../tools/build-data.mjs";
import { alertStreak, landStatus, normalizeDE } from "../src/ui/maps.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(here, p), "utf8");
// Real RKI files cut to 5 Sep - 6 Oct 2026 (CC BY 4.0, Robert Koch-Institut).
const NAT = read("fixtures/divi-deutschland.csv");
const LAND = read("fixtures/divi-bundeslaender.csv");

test("parseCsv reads the RKI header and keeps NA as text", () => {
  const rows = parseCsv("a,b\n1,NA\n2,3\n");
  assert.deepEqual(rows, [
    { a: "1", b: "NA" },
    { a: "2", b: "3" },
  ]);
});

test("buildDE: adult ICU figures for 6 Oct 2026 match the RKI national file", () => {
  const de = buildDE(NAT, LAND);
  assert.equal(de.asOf, "2026-10-06");
  assert.equal(de.group, "adults");
  assert.equal(de.meta.kind, "Live");
  assert.equal(de.meta.licence, "CC BY 4.0");
  assert.match(de.meta.url, /robert-koch-institut/);
  const n = de.national;
  assert.equal(n.areas, 746);
  assert.equal(n.occupied, 10065);
  assert.equal(n.free, 2258);
  assert.equal(n.reserve, 4418);
  assert.equal(n.ventFree, 2152);
  assert.equal(n.limits.staff, 127);
  assert.equal(n.status.noStatement, 220);
});

test("buildDE: 16 Länder, each with a 28-day ascending series ending on the report day", () => {
  const de = buildDE(NAT, LAND);
  assert.equal(de.laender.length, 16);
  for (const l of de.laender) {
    assert.equal(l.series.length, SERIES_DAYS, l.name);
    assert.equal(l.series.at(-1).date, de.asOf);
    for (let i = 1; i < l.series.length; i++) assert.ok(l.series[i - 1].date < l.series[i].date);
    assert.equal(l.series.at(-1).occupied, l.occupied);
  }
  const be = de.laender.find((l) => l.name === "Berlin");
  assert.deepEqual([be.areas, be.occupied, be.free, be.reserve, be.ventFree], [33, 461, 90, 259, 84]);
});

test("roll-up: the 16 Länder add up to the national figures", () => {
  const de = buildDE(NAT, LAND);
  const sum = rollUp(de.laender);
  for (const k of ["areas", "occupied", "free", "reserve", "ventFree"]) assert.equal(sum[k], de.national[k], k);
  assert.equal(sum.limits.staff, de.national.limits.staff);
  assert.equal(sum.status.noStatement, de.national.status.noStatement);
});

test("buildDE refuses a file without adult rows", () => {
  const head = NAT.split("\n")[0];
  assert.throws(() => buildDE(`${head}\n`, `${head}\n`), /no adult rows/);
});

const WB_COUNTRIES = [
  { page: 1, lastupdated: "2026-07-13" },
  [
    { id: "DEU", name: "Germany", region: { value: "Europe & Central Asia" } },
    { id: "ABW", name: "Aruba", region: { value: "Latin America & Caribbean" } },
    { id: "EUU", name: "European Union", region: { value: "Aggregates" } },
    ...Array.from({ length: 150 }, (_, i) => ({
      id: `X${String(i).padStart(2, "0")}`,
      name: `Test ${i}`,
      region: { value: "Test" },
    })),
  ],
];
const WB_BEDS = [
  { page: 1, lastupdated: "2026-07-13" },
  [
    { countryiso3code: "DEU", date: "2023", value: 7.55 },
    { countryiso3code: "DEU", date: "2022", value: 7.8 },
    { countryiso3code: "DEU", date: "2024", value: null },
    { countryiso3code: "ABW", date: "2023", value: null },
    { countryiso3code: "EUU", date: "2023", value: 5.1 },
  ],
];
const WB_POP = [{}, [{ countryiso3code: "DEU", date: "2025", value: 83491249 }]];

test("latestByCountry keeps the latest non-empty year", () => {
  const m = latestByCountry(WB_BEDS[1]);
  assert.deepEqual(m.get("DEU"), { value: 7.55, year: 2023 });
  assert.equal(m.has("ABW"), false);
});

test("buildWorld: aggregates dropped, missing values are null (Unknown), never 0", () => {
  const w = buildWorld(WB_BEDS, WB_POP, WB_COUNTRIES);
  assert.equal(w.meta.kind, "Official");
  assert.equal(w.meta.asOf, "2026-07-13");
  assert.equal(
    w.countries.find((c) => c.iso3 === "EUU"),
    undefined,
  );
  assert.deepEqual(w.countries.find((c) => c.iso3 === "DEU").beds, { value: 7.55, year: 2023 });
  assert.equal(w.countries.find((c) => c.iso3 === "ABW").beds, null);
});

// -- the committed snapshot in web/data -----------------------------------------------------------------
const DATA = path.join(here, "..", "data");

test("web/data: every file is under the size guard and carries its provenance", () => {
  for (const name of ["de-icu.json", "world.json"]) {
    const file = path.join(DATA, name);
    assert.ok(fs.statSync(file).size < MAX_BYTES, name);
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const k of ["kind", "source", "url", "licence", "asOf"]) assert.ok(json.meta?.[k], `${name} meta.${k}`);
  }
  assert.ok(fs.existsSync(path.join(DATA, "LICENSES.md")));
});

test("web/data/de-icu.json: Länder sum to the national total; the Germany page reads the same numbers", () => {
  const raw = JSON.parse(fs.readFileSync(path.join(DATA, "de-icu.json"), "utf8"));
  const sum = rollUp(raw.laender);
  assert.equal(sum.occupied, raw.national.occupied);
  assert.equal(sum.free, raw.national.free);
  const de = normalizeDE(raw);
  assert.equal(de.asOf, raw.asOf);
  assert.equal(de.total.occupied, raw.national.occupied);
  assert.equal(de.total.free, raw.national.free);
  assert.equal(de.total.reserve, raw.national.reserve);
  assert.equal(de.total.vent, raw.national.ventFree);
  assert.equal(de.total.staff, raw.national.limits.staff);
  assert.equal(de.laender.length, 16);
  const be = de.laender.find((l) => l.code === "BE");
  const rawBe = raw.laender.find((l) => l.name === "Berlin");
  assert.equal(be.free, rawBe.free);
  assert.equal(be.occupied, rawBe.occupied);
});

test("web/data/world.json: Germany has a beds value with its year", () => {
  const w = JSON.parse(fs.readFileSync(path.join(DATA, "world.json"), "utf8"));
  const de = w.countries.find((c) => c.iso3 === "DEU");
  assert.ok(de.beds.value > 0 && de.beds.year >= 2015);
  assert.ok(
    w.countries.every((c) => c.beds === null || c.beds.value > 0),
    "no zero stands in for Unknown",
  );
});

// -- the alert rule (concept 6.2): ≥90% AND <10 free, 3 days in a row ----------------------------------
const day = (d, occupied, free) => ({
  date: `2026-10-0${d}`,
  occupied,
  free,
  pct: (100 * occupied) / (occupied + free),
});

test("alertStreak counts consecutive days at ≥90% with fewer than 10 free", () => {
  assert.equal(alertStreak([day(1, 95, 5), day(2, 95, 5), day(3, 95, 5)]), 3);
  assert.equal(alertStreak([day(1, 95, 5), day(2, 80, 20), day(3, 95, 5)]), 1);
  // 90% but 10 free: the absolute threshold is not met
  assert.equal(alertStreak([day(1, 90, 10), day(2, 90, 10), day(3, 90, 10)]), 0);
  // a gap in the dates breaks the streak
  assert.equal(alertStreak([day(1, 95, 5), day(3, 95, 5)]), 1);
});

test("landStatus: Alert only after 3 days; Watch at ≥85% or under 10 free", () => {
  assert.equal(landStatus({ streak: 3, pct: 95, free: 5 }).label, "Alert");
  assert.equal(landStatus({ streak: 2, pct: 95, free: 5 }).label, "Watch");
  assert.equal(landStatus({ streak: 0, pct: 86, free: 40 }).label, "Watch");
  assert.equal(landStatus({ streak: 0, pct: 70, free: 40 }).label, "Normal");
});
