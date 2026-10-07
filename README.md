# MetaHospital

Hospital capacity at every level, from the world down to one hospital unit: World, Country
(Germany), Land and City (Berlin), Hospital and Unit. Each level has a real user (WHO analyst,
ministry desk, city health authority, hospital director, charge nurse) and clear rules for what
it shares upward, with peers and never.

**Live:** https://etohidi.github.io/MetaHospital/

The top levels show **real open data** with its source and date: daily adult ICU capacity per
Land from the DIVI-Intensivregister (Robert Koch-Institut) and hospital beds per 1,000 people
from the World Bank. The hospital and unit levels run a **simulation** on three fictional "demo
twin" hospitals in Berlin, kept apart from the real figures. Every number carries a badge: Live,
Official, Simulated, Illustrative, Not shown or Unknown.

Every hour of the simulated day, rule-based planners for the Emergency Department, Intensive
Care and the General Ward propose patient moves. A Coordinator bundles them into one plan, a
Safety check blocks anything that breaks a hard rule, and a Regional coordinator offers
patients the hospital can't take to neighbouring hospitals with room. Nothing changes until
the charge nurse (you) approves the plan. A rejection reason goes back to the planners and
shapes their next plan, and families are only told about approved changes.

Everything runs in the browser. The demo-twin patients, beds and hospitals are simulated, and
their names are fictional.

## Try it

Open the live page and follow [DEMO.md](DEMO.md) for a seven-minute walkthrough: the Germany
ministry view on real DIVI data, the World page, Berlin, then a demo-twin hospital where you
approve a plan, trigger a bus accident from the Simulation drawer, watch the Safety check stop a
premature ambulance diversion, and drill down to a single unit.

To run it locally you need Node.js 20 or newer; there is nothing to install:

```bash
git clone https://github.com/ETohidi/MetaHospital.git
cd MetaHospital/web
npm run serve   # http://127.0.0.1:8080
npm test        # engine, data pipeline and level-model tests
npm run data    # refresh web/data from DIVI and the World Bank (optional; a snapshot is committed)
```

## How it's built

A static site with no build step and no backend: vanilla JavaScript modules, with d3 and
topojson from a CDN for the maps and the Inter font self-hosted. Real data is fetched at build
time by `web/tools/build-data.mjs` into small JSON files in `web/data/`. The simulation engine is deterministic for a given seed,
so the default day replays the same way every time. See [web/README.md](web/README.md) for
the architecture.

Every push to `main` runs the tests and publishes `web/` to GitHub Pages
(`.github/workflows/pages.yml`). Once a day the same workflow refreshes `web/data`, commits the
new snapshot and redeploys.

## Licence and data

The code is MIT licensed ([LICENSE](LICENSE)). The data keeps its source licence, listed in
[web/data/LICENSES.md](web/data/LICENSES.md): DIVI-Intensivregister and World Bank under
CC BY 4.0; cited reference values from Destatis (dl-de/by-2.0), the Berlin hospital register
(dl-de/zero-2.0) and Berlin hospital statistics (CC BY 3.0 DE). Inter is under the SIL OFL.

## Map data

Natural Earth 1:110m countries (public domain) via world-atlas; Berlin districts from Berliner
Morgenpost Berlin-Geodaten (CC BY, Amt für Statistik Berlin-Brandenburg). Both simplified for
size.
