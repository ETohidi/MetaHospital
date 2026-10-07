// Loads the real open data written by tools/build-data.mjs (web/data/*.json).
// Views get the result as ctx.data and the loading state as ctx.dataState (see main.js).
// A file that fails to load becomes null with its error in errors[key]; the other files still load.

const BASE = new URL("../../data/", import.meta.url);

/** Files the site reads: key on RealData -> file name in web/data. */
export const REAL_FILES = { de: "de-icu.json", world: "world.json" };

async function getJson(name) {
  const res = await fetch(new URL(name, BASE), { cache: "no-cache" });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.json();
}

/**
 * @returns {Promise<import("../engine/types.js").RealData>} {de, world, errors}; resolves even when a file
 *   fails, and rejects only when every file failed.
 */
export async function loadRealData() {
  const keys = Object.keys(REAL_FILES);
  const results = await Promise.allSettled(keys.map((k) => getJson(REAL_FILES[k])));
  const data = { errors: {} };
  results.forEach((r, i) => {
    data[keys[i]] = r.status === "fulfilled" ? r.value : null;
    if (r.status === "rejected") data.errors[keys[i]] = r.reason;
  });
  if (results.every((r) => r.status === "rejected")) throw results[0].reason;
  return data;
}
