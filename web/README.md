# MetaHospital web MVP

A multi-level digital twin of a small Berlin hospital network (Klinikum Kreuzberg and two
neighbours), from the whole planet down to a single bed. It is a static site: the hospital
simulation and the planning layer run in the browser, with no backend and no build step.

## Run it

```bash
npm run serve   # http://127.0.0.1:8080
npm test        # engine tests (Node 20+)
```

Any static file server works too; the page only needs to be served over HTTP, because ES
modules don't load from `file://`. d3 and topojson come from cdnjs, so the maps need a
network connection.

## How it fits together

```
index.html ─ src/main.js ─┬─ src/engine/twin.js   the twin (state, hourly loop, queries)
                          ├─ src/ui/maps.js       Earth / Germany / Berlin
                          ├─ src/ui/hospital.js   a hospital: bed board, plan, conversation
                          └─ src/ui/unit.js       one unit: occupancy, queue, patients
```

`main.js` owns routing, the zoom ladder, the simulation controls and the render loop. Every
view exports `render(container, ctx)` and rebuilds its markup from `twin.snapshot()` each
time the twin changes. `src/engine/types.js` documents every shape the engine hands out.

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

- **GitHub Pages:** every push to `main` runs the tests and deploys `index.html`, `src/`
  and `styles/` (see `../.github/workflows/pages.yml`). Any other static host works too:
  serve this folder as is; all paths are relative.
- **claude.ai artifact:** `npm run artifact` writes `dist/artifact.html` (the page without
  its document skeleton, which the artifact host adds). Publish that file with `styles/**`
  and `src/**` as supporting files at the same paths.

## Data

Hospital names are fictional and every number is simulated. Map data: Natural Earth 1:110m
countries (public domain) via world-atlas, German states from deutschlandGeoJSON
(Unlicense), Berlin districts from Berliner Morgenpost Berlin-Geodaten (CC BY, Amt für
Statistik Berlin-Brandenburg), all simplified for size.
