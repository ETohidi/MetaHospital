# MetaHospital

A digital twin of a small Berlin hospital network that you can zoom through at five
levels: Earth, Germany, Berlin, a hospital, and one of its units, down to a single bed.

**Live:** https://etohidi.github.io/MetaHospital/

Every hour of the simulated day, rule-based planners for the Emergency Department, Intensive
Care and the General Ward propose patient moves. A Coordinator bundles them into one plan, a
Safety check blocks anything that breaks a hard rule, and a Regional coordinator offers
patients the hospital can't take to neighbouring hospitals with room. Nothing changes until
the charge nurse (you) approves the plan. A rejection reason goes back to the planners and
shapes their next plan, and families are only told about approved changes.

Everything runs in the browser. The patients, beds and hospitals are simulated, and the
hospital names are fictional.

## Try it

Open the live page and follow [DEMO.md](DEMO.md) for a five-minute walkthrough: approve a
plan, trigger a bus accident, watch the Safety check stop a premature ambulance diversion,
and drill down from Berlin to a single unit.

To run it locally you need Node.js 20 or newer; there is nothing to install:

```bash
git clone https://github.com/ETohidi/MetaHospital.git
cd MetaHospital/web
npm run serve   # http://127.0.0.1:8080
npm test        # engine tests
```

## How it's built

A static site with no build step and no backend: vanilla JavaScript modules, with d3 and
topojson from a CDN for the maps. The simulation engine is deterministic for a given seed,
so the default day replays the same way every time. See [web/README.md](web/README.md) for
the architecture.

Every push to `main` runs the tests and publishes `web/` to GitHub Pages
(`.github/workflows/pages.yml`).

## Map data

Natural Earth 1:110m countries (public domain) via world-atlas; German states from
deutschlandGeoJSON (Unlicense); Berlin districts from Berliner Morgenpost Berlin-Geodaten
(CC BY, Amt für Statistik Berlin-Brandenburg). All simplified for size.
