// Fetches the real open data the site shows and writes small JSON files to web/data/.
//   node tools/build-data.mjs        (npm run data)
// Sources (both CC BY 4.0, see web/data/LICENSES.md):
//   - DIVI-Intensivregister open data, published daily by the RKI on GitHub (adult ICU, Germany + 16 Länder)
//   - World Bank WDI: hospital beds per 1,000 (SH.MED.BEDS.ZS) and population (SP.POP.TOTL)
// No runtime dependencies. If a fetch fails, the committed file stays as it is (it is the fallback).
// The parsers are exported so test/data.test.js can check them without the network.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "data");
export const MAX_BYTES = 5 * 1024 * 1024; // size guard: no data file may exceed 5 MB
export const SERIES_DAYS = 28;

const RKI_REPO =
  "https://github.com/robert-koch-institut/Intensivkapazitaeten_und_COVID-19-Intensivbettenbelegung_in_Deutschland";
const RKI_RAW =
  "https://raw.githubusercontent.com/robert-koch-institut/Intensivkapazitaeten_und_COVID-19-Intensivbettenbelegung_in_Deutschland/main";
export const DIVI_SOURCE = {
  kind: "Live",
  source: "DIVI-Intensivregister (Robert Koch-Institut)",
  url: RKI_REPO,
  licence: "CC BY 4.0",
};
export const WB_SOURCE = {
  kind: "Official",
  source: "World Bank WDI (SH.MED.BEDS.ZS, SP.POP.TOTL)",
  url: "https://data.worldbank.org/indicator/SH.MED.BEDS.ZS",
  licence: "CC BY 4.0",
};
const WB_API = "https://api.worldbank.org/v2";

// -- parsers ----------------------------------------------------------------------------------------

/** Parses the RKI CSV files (comma separated, no quoted commas, "NA" for missing). */
export function parseCsv(text) {
  const lines = text.replace(/^﻿/, "").trim().split(/\r?\n/);
  const head = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(head.map((h, i) => [h, cells[i]]));
  });
}

const n = (v) => (v === undefined || v === "" || v === "NA" ? null : Number(v));

/** One DIVI row (adults) -> the figures the site shows. */
export function figuresOf(r) {
  return {
    areas: n(r.anzahl_meldebereiche),
    occupied: n(r.intensivbetten_belegt),
    free: n(r.intensivbetten_frei),
    reserve: n(r.intensivbetten_7_tage_notfallreserve),
    ventFree: n(r.kapazitaeten_frei_invasive_beatmung_gesamt),
    status: {
      regular: n(r.betriebssituation_regulaerer_betrieb),
      partly: n(r.betriebssituation_teilweise_eingeschraenkt),
      limited: n(r.betriebssituation_eingeschraenkt),
      noStatement: n(r.betriebssituation_keine_angabe),
    },
    limits: {
      staff: n(r.einschraenkung_personal),
      material: n(r.einschraenkung_material),
      room: n(r.einschraenkung_raum),
      equipment: n(r.einschraenkung_beatmungsgeraet),
    },
  };
}

const isAdult = (r) => r.behandlungsgruppe === "Erwachsene";
const daysBefore = (iso, days) => new Date(Date.parse(`${iso}T12:00:00Z`) - days * 864e5).toISOString().slice(0, 10);

/**
 * Builds the Germany ICU file from the national and the Länder CSV (adult ICU only).
 * Shape: {asOf, meta: {kind, source, url, licence, asOf, generatedAt}, group, national: {...figures, series},
 *         laender: [{id, name, ...figures, series}]}. The meta record is the provenance of every value in the file.
 * Each series holds the last SERIES_DAYS days, ascending, as {date, occupied, free}.
 */
export function buildDE(nationalCsv, laenderCsv, { days = SERIES_DAYS, generatedAt = null } = {}) {
  const nat = parseCsv(nationalCsv).filter(isAdult);
  const land = parseCsv(laenderCsv).filter(isAdult);
  if (!nat.length || !land.length) throw new Error("DIVI CSV has no adult rows");
  const asOf = land.reduce((m, r) => (r.datum > m ? r.datum : m), "");
  const from = daysBefore(asOf, days - 1);
  const point = (r) => ({ date: r.datum, occupied: n(r.intensivbetten_belegt), free: n(r.intensivbetten_frei) });
  const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

  const laender = new Map();
  for (const r of land) {
    if (r.datum < from) continue;
    const l = laender.get(r.bundesland_id) ?? { id: r.bundesland_id, name: r.bundesland_name, series: [] };
    l.series.push(point(r));
    if (r.datum === asOf) Object.assign(l, figuresOf(r));
    laender.set(r.bundesland_id, l);
  }
  const list = [...laender.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const l of list) {
    l.series.sort(byDate);
    if (l.occupied === undefined) throw new Error(`DIVI: ${l.name} has no row for ${asOf}`);
  }
  if (list.length !== 16) throw new Error(`DIVI: expected 16 Länder, got ${list.length}`);

  const natToday = nat.find((r) => r.datum === asOf);
  if (!natToday) throw new Error(`DIVI: the national file has no row for ${asOf}`);
  const national = {
    ...figuresOf(natToday),
    series: nat
      .filter((r) => r.datum >= from && r.datum <= asOf)
      .map(point)
      .sort(byDate),
  };
  return { asOf, meta: { ...DIVI_SOURCE, asOf, generatedAt }, group: "adults", national, laender: list };
}

/** Sums the Länder figures (used by the tests to prove the national file and the Länder agree). */
export function rollUp(laender) {
  const keys = ["areas", "occupied", "free", "reserve", "ventFree"];
  const out = Object.fromEntries(keys.map((k) => [k, laender.reduce((s, l) => s + (l[k] ?? 0), 0)]));
  for (const group of ["status", "limits"]) {
    out[group] = {};
    for (const k of Object.keys(laender[0][group])) out[group][k] = laender.reduce((s, l) => s + (l[group][k] ?? 0), 0);
  }
  return out;
}

/** Latest non-null value per ISO3 code from a World Bank indicator response ([meta, rows]). */
export function latestByCountry(rows, keep) {
  const out = new Map();
  for (const r of rows ?? []) {
    const iso3 = r.countryiso3code;
    if (r.value === null || r.value === undefined || !iso3 || (keep && !keep.has(iso3))) continue;
    const year = Number(r.date);
    const prev = out.get(iso3);
    if (!prev || year > prev.year) out.set(iso3, { value: r.value, year });
  }
  return out;
}

/**
 * Builds the World file: every World Bank economy (aggregates removed) with its latest beds per 1,000
 * and population, each with its year. A country without a value gets null, never 0.
 */
export function buildWorld(bedsResp, popResp, countriesResp, { generatedAt = null } = {}) {
  const economies = (countriesResp?.[1] ?? []).filter((c) => c.region?.value !== "Aggregates" && c.id);
  if (economies.length < 150) throw new Error(`World Bank: only ${economies.length} economies`);
  const names = new Map(economies.map((c) => [c.id, c.name]));
  const keep = new Set(names.keys());
  const beds = latestByCountry(bedsResp?.[1], keep);
  const pop = latestByCountry(popResp?.[1], keep);
  const countries = [...names]
    .map(([iso3, name]) => ({ iso3, name, beds: beds.get(iso3) ?? null, population: pop.get(iso3) ?? null }))
    .sort((a, b) => a.iso3.localeCompare(b.iso3));
  const asOf = String(bedsResp?.[0]?.lastupdated ?? "").slice(0, 10) || null;
  return { meta: { ...WB_SOURCE, asOf, generatedAt }, countries };
}

// -- fetch and write --------------------------------------------------------------------------------

async function get(url, as = "text") {
  const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return as === "json" ? res.json() : res.text();
}

function write(name, data) {
  const text = `${JSON.stringify(data)}\n`;
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_BYTES) throw new Error(`${name} is ${bytes} bytes, over the ${MAX_BYTES} byte limit`);
  fs.writeFileSync(path.join(OUT, name), text);
  console.log(`wrote data/${name} (${(bytes / 1024).toFixed(1)} KB)`);
}

const JOBS = {
  "de-icu.json": async (generatedAt) => {
    const [national, laender] = await Promise.all([
      get(`${RKI_RAW}/Intensivregister_Deutschland_Kapazitaeten.csv`),
      get(`${RKI_RAW}/Intensivregister_Bundeslaender_Kapazitaeten.csv`),
    ]);
    const de = buildDE(national, laender, { generatedAt });
    console.log(
      `DIVI ${de.asOf}: ${de.national.occupied} occupied, ${de.national.free} free, ${de.national.areas} areas`,
    );
    return de;
  },
  "world.json": async (generatedAt) => {
    const year = new Date().getUTCFullYear();
    const [beds, pop, countries] = await Promise.all([
      get(`${WB_API}/country/all/indicator/SH.MED.BEDS.ZS?format=json&date=1960:${year}&per_page=20000`, "json"),
      get(`${WB_API}/country/all/indicator/SP.POP.TOTL?format=json&date=${year - 10}:${year}&per_page=20000`, "json"),
      get(`${WB_API}/country?format=json&per_page=400`, "json"),
    ]);
    const world = buildWorld(beds, pop, countries, { generatedAt });
    const de = world.countries.find((c) => c.iso3 === "DEU");
    console.log(
      `World Bank ${world.meta.asOf}: ${world.countries.length} economies, Germany ${de?.beds?.value} (${de?.beds?.year})`,
    );
    return world;
  },
};

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const generatedAt = new Date().toISOString();
  let failed = 0;
  for (const [name, job] of Object.entries(JOBS)) {
    try {
      write(name, await job(generatedAt));
    } catch (err) {
      const kept = fs.existsSync(path.join(OUT, name));
      console.warn(`${name}: ${err.message}${kept ? " - keeping the committed file" : ""}`);
      if (!kept) failed += 1;
    }
  }
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
