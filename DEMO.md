# MetaHospital demo (7 minutes)

MetaHospital shows hospital capacity at every level, from the world down to one unit. The top
levels (World, Germany, Berlin) show **real open data** with source and date. The hospital and
unit levels run a **simulation** on three fictional "demo twin" hospitals, so the planning layer
can be shown without any real patient. Every number carries a badge that says which it is:
Live, Official, Simulated, Illustrative, Not shown or Unknown.

## Start

Open https://etohidi.github.io/MetaHospital/, or run it locally:

```bash
cd web && npm run serve
```

Then open http://127.0.0.1:8080. The site opens on **Germany**, as the ministry situation desk
sees it. The simulation always starts the same way (seed 20260926): 12:00 on a Wednesday, with
three hours of history already replayed and a first plan waiting.

## Choreography

1. **Germany, real data.** The page head says what this level may see: Länder totals, and
   per-site ICU status as DIVI publishes it. The five KPI tiles are the adult ICU figures of
   the latest DIVI-Intensivregister report (badge **Live**, date in the head): occupancy with a
   28-day sparkline, free beds, the 7-day reserve, free ventilation places, and the areas
   limited by staff. That last tile counts only the areas that answered; "no statement" is its
   own hatched segment. Below, the 16 Länder are equal tiles (Bremen is as visible as Bayern),
   and the table groups them by Kleeblatt cluster. Hover a tile and its row lights up. The
   rail shows **Alerts & requests**: a Land is on alert only when it is at least 90% full
   **and** has fewer than 10 free beds for 3 days in a row. The per-site layer is marked
   "exists, not shown (licence pending)". No hospital is named on this page.

2. **World.** Click **World** in the breadcrumb. The map shows hospital beds per 1,000 people
   (World Bank, **Official**), each country at its latest year; hatched countries report data
   older than 3 years, grey ones are Unknown, never 0. Germany is selected: 7.55 (2023). The
   country table sorts by any column. Click **Open Germany** to go back down.

3. **Berlin.** Click the **BE** tile or the Berlin row. The KPIs are the real DIVI figures for
   Berlin, with the planned beds (hospital plan) and set-up beds (2024 statistics) as Official
   context. The block **Demo twins (simulated)** is the separate demo layer: three fictional
   hospitals, never added to the real figures. Click **Open Kreuzberg** on the
   Klinikum Kreuzberg card, the twin we run.

4. **The hospital director's screen.** KPIs, the units table with closed beds hatched, and on
   the right **Requests** with the plan for 12:00–13:00: the ICU and Ward planners want to take
   the patients waiting in the ED. Click **Approve plan**. The patients move upstairs and
   **What families see** gets one message per move. Peers appear only as status per
   capability (Available / Limited / Not available), never as exact counts.

5. **Bus accident.** Open the **Simulation** drawer in the top bar (it holds every demo
   control) and click **Bus accident**. Twenty casualties arrive at the ED, which jumps far
   past 100% (the extra patients wait in the hallway row), and a red "Simulated emergency" strip
   appears under the top bar.

6. **Next hour.** The plan for 13:00–14:00 is big. The ED planner asks to divert ambulances, and
   the Safety check allows it because the ED is over 95% full. The ICU and Ward take every
   patient they have beds for, and the Regional coordinator sends three ICU patients to
   Rixdorf Hospital, the only neighbour that reported free ICU beds. Open **Actions, safety
   check and offers** to see each action. Approve it.

7. **Next hour again.** The ED is back under 95%, but its planner asks to keep diverting. The
   Safety check blocks it: "Ambulances are only diverted while the ED is more than 95% full."
   Pick **Wrong priority order** as the reason and click **Reject**. On the next hour the ED
   planner notes the rejection and no longer asks to divert.

8. **Drill into a unit.** Click **Open ICU** on the bed board. The charge nurse's screen shows
   beds in use over the day with a 6-hour projection, arrivals and moves per hour, everyone
   waiting to move in, and every (simulated) patient. The same Approve / Reject card is here.

9. **Back out.** Click **Berlin** in the breadcrumb. The real DIVI figures have not moved; the
   accident shows only in the demo-twin block. Real and simulated numbers never mix.

**Play** in the drawer advances the simulation by itself (1×, 2× or 4×). A plan that nobody
decides on expires when the next hour's plan arrives. **Restart** replays the same day.

If the ED is still above 95% at step 7 (it can happen if you deviate from the steps above),
the keep-diverting request is correctly allowed; press **Next hour** once more to see the block.

Every page ends with **Who uses this level, and what crosses its boundary** (user, what goes up,
to peers and never, each with its legal basis) and **Data & sources** (every dataset with its
badge, licence and link).

## What this demonstrates

- **One anatomy at every level.** World, Country, City, Hospital and Unit share the same page
  head, five KPI slots, rail and sources footer, so a user always knows where to look.
- **Real data where it exists.** DIVI-Intensivregister (RKI, CC BY 4.0) for Germany and Berlin,
  refreshed daily; World Bank (CC BY 4.0) for the world. Each value shows its date.
- **Planners propose, a person decides.** Rule-based unit planners propose moves each hour; the
  Coordinator bundles them; nothing changes until a person approves.
- **Safety check.** Deterministic rules screen every action; blocked actions stay visible with
  the rule.
- **Human feedback.** A rejection reason goes back to the planners who asked, and changes what
  they propose next.
- **Sharing rules.** Peers see status per capability; patient data never enters the shared
  layer; logging and purpose binding are illustrated, not enforced, on this static site.
