# MetaHospital – multi-level hospital digital twin (static web MVP)

A browser-only digital twin of a small Berlin hospital network, viewed at five levels:
Earth > Germany > Berlin > hospital > unit. The simulation and the rule-based planning
layer (unit planners, Coordinator, Safety check, Regional coordinator, charge-nurse
approve/reject, family messages) run entirely in the browser. There is no backend and no LLM.

## Repo layout
- web/                 the whole MVP (static site, no build step)
  - index.html         page shell; loads d3 + topojson from cdnjs, then src/main.js
  - src/main.js        router (hash tokens), top bar, simulation controls, render loop
  - src/engine/        the twin: seeded sim, planners, coordinator, safety, family; twin.js is the facade
  - src/engine/types.js  the data contract between engine and views - keep it in sync
  - src/ui/            views: maps.js (levels 1-3), hospital.js (level 4), unit.js (level 5), dom.js helpers
  - src/data/          places.js (fictional hospitals) and simplified geo data
  - styles/            base.css (design tokens + shared components) and one stylesheet per view
  - test/              node:test suite for the engine
  - tools/             serve.mjs (local server), make-artifact.mjs (claude.ai artifact build)
- .github/workflows/pages.yml  tests + deploys web/ to GitHub Pages on every push to main
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
- Hospital names are fictional on purpose; never use real hospital names with simulated numbers.

## Commands (from web/)
- `npm test`           run the engine tests
- `npm run serve`      serve the site at http://127.0.0.1:8080
- `npm run artifact`   write dist/artifact.html for publishing as a claude.ai artifact

## Working style
- Small steps, ask before large refactors.
- Prefer simple code over clever code.
