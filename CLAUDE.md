# MetaHospital – multi-level hospital capacity twin (static web MVP)

A browser-only, multi-level view of hospital capacity: World > (EU) > Country > Land > City >
Hospital > Unit. Each level has a real-world user (WHO analyst, ministry, Land/city health
authority, hospital director, charge nurse) and clear rules for what it shares upward, with
peers and never. The top levels show real open data (World Bank, DIVI-Intensivregister);
the hospital and unit levels run the seeded simulation on fictional "demo twin" hospitals,
with the rule-based planning layer (unit planners, Coordinator, Safety check, Regional
coordinator, approve/reject, family messages). There is no backend and no LLM.

## Repo layout
- web/                 the whole MVP (static site, no build step)
  - index.html         page shell; loads d3 + topojson from cdnjs, then src/main.js
  - src/main.js        router (hash tokens), simulation actions, render loop
  - src/engine/        the twin: seeded sim, planners, coordinator, safety, family; twin.js is the facade
  - src/engine/types.js  the data contract between engine, data files and views - keep it in sync
  - src/ui/            views and shared pieces:
    - shell.js         app bar: breadcrumb of places (level names) and the Simulation drawer
    - page.js          shared page anatomy: provenance badge, status pill, page head, 5-slot KPI strip, sources footer
    - levels.js        the level model (user, decides, shares up / peers / never with legal basis, cadence, KPI tiles) and its panel
    - world.js (World), maps.js (Country: Germany; City: Berlin), hospital.js (Hospital), unit.js (Unit), dom.js helpers
  - src/data/          places.js (fictional demo twins), real.js (loads web/data), simplified geo data (world.js, berlin.js)
  - data/              real open data written by tools/build-data.mjs: de-icu.json (DIVI), world.json (World Bank), LICENSES.md
  - styles/            base.css (tokens, app bar, shared components), page.css (page anatomy), one stylesheet per view, fonts/ (Inter woff2 + OFL)
  - test/              node:test suite: engine, data pipeline (test/fixtures: real RKI CSV extracts), level model
  - tools/             serve.mjs (local server), build-data.mjs (npm run data), make-artifact.mjs (claude.ai artifact build)
- .github/workflows/pages.yml  tests + deploys web/ to GitHub Pages on every push to main; daily data refresh + deploy
- LICENSE              MIT (code); data licences in web/data/LICENSES.md
- docs/                pitch deck (local only, gitignored)

## Rules
- Vanilla ES modules only. No bundler, no npm runtime dependencies. d3 and topojson are the
  only libraries, loaded as UMD globals from cdnjs (the claude.ai artifact CSP allows cdnjs).
- The engine never touches the DOM, Math.random or Date: all randomness goes through the
  Twin's seeded rng, so a seed always replays the same day.
- Views only read `twin.snapshot()` and the Twin's query methods, and change the twin only
  through `tick()`, `surge()`, `decide()` and `reset()`.
- Build markup with the `html` tagged template from dom.js (it escapes everything); colours
  only through the tokens in base.css so light and dark themes both work.
- Routes are plain hash tokens (`#berlin`, `#kreuzberg.icu`) because the artifact viewer
  drops anything else.
- Every number carries a provenance badge: Live, Official, Estimated, Simulated, Illustrative,
  Not shown or Unknown. Unknown is never shown as 0.
- Real hospital names appear only next to Live or Official values. Estimated or Simulated values
  appear only on the fictional demo twins or on anonymous aggregates at district level or above.
  The demo twins never change a real total.
- Real data comes from open sources with their licence recorded (web/data/LICENSES.md); every
  value keeps {kind, source, url, licence, asOf}.
- Fonts are self-hosted (Inter, SIL OFL). No Google Fonts or other third-party font hosts.
- Show level names in the UI (World, EU, Country, Land, City, Hospital, Unit), never level numbers.
- `main` deploys to the live site on every push: develop on a branch and merge when it's verified.

## Commands (from web/)
- `npm test`           run the engine, data pipeline and level-model tests
- `npm run data`       refresh web/data from DIVI and the World Bank (keeps the committed file if a fetch fails)
- `npm run serve`      serve the site at http://127.0.0.1:8080
- `npm run artifact`   write dist/artifact.html for publishing as a claude.ai artifact

## Working style
- Small steps, ask before large refactors.
- Prefer simple code over clever code.
