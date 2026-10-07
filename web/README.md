# MetaHospital web MVP

Hospital capacity at every level: World, Country (Germany), Land · City (Berlin), Hospital and
Unit. The top levels show real open data (World Bank, DIVI-Intensivregister); the hospital and
unit levels run the seeded simulation on three fictional demo twins (Klinikum Kreuzberg and two
neighbours). It is a static site: the simulation and the planning layer run in the browser, with
no backend and no build step.

## Run it

```bash
npm run serve   # http://127.0.0.1:8080
npm test        # engine, data pipeline and level-model tests (Node 20+)
npm run data    # fetch DIVI + World Bank into data/*.json (Node 20+, network)
```

Any static file server works too; the page only needs to be served over HTTP, because ES
modules don't load from `file://`. d3 and topojson come from cdnjs, so the maps need a
network connection.

## How it fits together

```
index.html ─ src/main.js ─┬─ src/ui/shell.js      app bar: breadcrumb + Simulation drawer
                          ├─ src/data/real.js     loads data/*.json (real open data)
                          ├─ src/engine/twin.js   the twin (state, hourly loop, queries)
                          ├─ src/ui/world.js      World: beds per 1,000 (World Bank)
                          ├─ src/ui/maps.js       Germany (ministry desk) and Berlin (DIVI + demo twins)
                          ├─ src/ui/hospital.js   a demo-twin hospital: director's screen
                          └─ src/ui/unit.js       one unit: charge nurse's screen
   shared by every view:  src/ui/page.js (head, KPI strip, badges, sources),
                          src/ui/levels.js (who uses each level, what crosses its boundary),
                          src/ui/dom.js (html`` escaping, chips, meters)
tools/build-data.mjs ──── data/de-icu.json, data/world.json (+ LICENSES.md)
```

`main.js` owns routing, the simulation actions and the render loop. Every view exports
`render(container, ctx)`; `ctx` carries the twin's snapshot plus the real data
(`ctx.data`, `ctx.dataState`). `src/engine/types.js` documents every shape the engine and the
data files hand out.

Routes are plain hash tokens: `#world`, `#germany` (the default), `#berlin`, `#kreuzberg`,
`#kreuzberg.icu`. The old `#earth` redirects to `#world`.

Each simulated hour (`twin.tick()`):

1. **Simulation** (`sim.js`): arrivals, discharges, patients waiting in the ED for a bed
   upstairs, neighbour hospitals drifting.
2. **Unit planners** (`planners.js`): the ED, ICU and Ward planners each propose actions from
   their unit's census.
3. **Regional coordinator** (`regional.js`): every hospital reports what it can accept.
4. **Coordinator** (`coordinator.js`): resolves conflicts, runs the **Safety check**
   (`safety.js`), and adds diverts to neighbours for ICU patients who can't get a bed here.
5. The plan waits for the **charge nurse** (`twin.decide()`). Approving applies it and sends
   family messages (`family.js`); rejecting sends the reason back to the planners who asked.

The engine is deterministic: all randomness comes from a seeded generator (`rng.js`), so the
default seed replays the same day every time. See `../DEMO.md` for the demo walkthrough.

## Publish

- **GitHub Pages:** every push to `main` runs the tests and deploys `index.html`, `src/`,
  `styles/` and `data/` (see `../.github/workflows/pages.yml`). A daily scheduled run
  refreshes `data/`, commits it and deploys in the same run. Any other static host works too:
  serve this folder as is; all paths are relative.
- **claude.ai artifact:** `npm run artifact` writes `dist/artifact.html` (the page without
  its document skeleton, which the artifact host adds). Publish that file with `styles/**`
  (including `styles/fonts/`), `src/**` and `data/*.json` as supporting files at the same paths.

## Data

Real data: `data/de-icu.json` (DIVI-Intensivregister, adult ICU per Land and nationally, last 28
days; Robert Koch-Institut, CC BY 4.0) and `data/world.json` (World Bank WDI beds per 1,000 and
population, latest year per economy; CC BY 4.0). Every file carries `meta: {kind, source, url,
licence, asOf, generatedAt}`; see `data/LICENSES.md`. If a fetch fails, `npm run data` keeps the
committed file.

Simulated data: the three demo-twin hospitals, their names and every patient are fictional.

Map data: Natural Earth 1:110m countries (public domain) via world-atlas and Berlin districts
from Berliner Morgenpost Berlin-Geodaten (CC BY, Amt für Statistik Berlin-Brandenburg), both
simplified for size. Font: Inter (SIL OFL), self-hosted in `styles/fonts/`.
