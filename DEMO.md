# MetaHospital demo (5 minutes)

MetaHospital is a digital twin of a small Berlin hospital network that you can zoom
through at five levels: Earth, Germany, Berlin, a hospital, and one of its units. Everything
runs in the browser. The patients, beds and hospitals are simulated, and the hospital names
are fictional.

## Start

Open https://etohidi.github.io/MetaHospital/, or run it locally:

```bash
cd web && npm run serve
```

Then open http://127.0.0.1:8080. The day always starts the same way (seed 20260926): 12:00 on
a Wednesday, with three hours of history already replayed and a first plan waiting.

## Choreography

1. **Zoom in.** Start on Earth and click Germany, then Berlin. On the Berlin map every
   hospital is a pin coloured by how full its ICU and Ward are. The dashed lines show what
   each neighbour told the Regional coordinator it can take this hour. Click
   **Klinikum Kreuzberg**, the hospital we run.

2. **Read the bed board.** One square per bed in the ED, ICU and Ward, coloured by acuity
   from 1 (non-urgent) to 5 (immediate) in the Manchester Triage colours. Hatched squares
   are beds with no staff today. On the right
   is the plan for 12:00–13:00: the ICU and Ward planners want to take the patients waiting
   for them in the ED, each with a confidence and a reason. Click **Approve plan**. The
   patients move upstairs, and **What families see** gets one message per move.

3. **Bus accident.** Click **Bus accident** in the top bar. Twenty casualties arrive at the
   ED, which jumps well past 100% (the extra patients wait in the hallway row), and the
   emergency banner appears.

4. **Next hour.** The plan for 13:00–14:00 is big. The ED planner asks to divert ambulances, and the
   Safety check allows it because the ED is over 95% full. The ICU and Ward take every
   patient they have beds for. The ICU still can't place four patients, so the Regional
   coordinator sends three of them to Rixdorf Hospital, the only neighbour that reported
   free ICU beds; the fourth keeps waiting. Approve it.

5. **Next hour again.** The ED is back under 95%, but its planner asks to keep diverting
   ambulances. The Safety check blocks it: "Ambulances are only diverted while the ED is
   more than 95% full." The block shows on the plan card and in the Team conversation.
   Pick **Wrong priority order** as the reason and click **Reject plan**.

6. **Next hour.** The ED planner's note now ends with "(Noting recent rejection: Wrong
   priority order)", and it no longer asks to divert. A rejection is remembered for four
   hours and only reaches the planners who asked for something in that plan.

7. **Drill into a unit.** Click **Open ICU** on the bed board (or ICU in the zoom ladder).
   The unit view shows beds in use over the day with a 6-hour projection, arrivals, moves
   and discharges per hour, everyone waiting to move in, the conditions right now, and
   every patient with their bed and expected discharge time. Switch to **ED** to see the
   accident as a spike in arrivals.

8. **Back out.** Use the zoom ladder at the top to go back to Berlin. Rixdorf Hospital, which
   took the diverted ICU patients, now shows fewer free ICU beds.

**Play** advances the simulation by itself (1×, 2× or 4×). A plan that nobody decides on
expires when the next hour's plan arrives. **Restart** replays the same day and brings back
the 12:00 plan.

If ED is still above 95% at step 5 (it can happen if you deviate from the steps above), the
keep-diverting request is correctly allowed; press **Next hour** once more to see the block.

## What this demonstrates

- **Five levels, one twin.** The same simulated state, summarised at the scale of each level:
  the network on Earth, the connected region in Germany, every hospital's free beds in
  Berlin, every bed in the hospital, every patient in a unit.
- **Planners propose, a person decides.** Rule-based unit planners propose moves each hour,
  and the Coordinator bundles them into one plan with before/after bed counts. Nothing
  changes until the charge nurse approves.
- **Safety check.** Deterministic rules screen every action before a person sees it: usable
  beds, early-discharge limits, overflow limits, ambulance diversion only above 95%, and
  transfers only to hospitals that reported room. Blocked actions stay visible with the rule.
- **Human feedback.** A rejection reason goes back to the planners who asked, and changes
  what they propose next.
- **Neighbouring hospitals.** The Regional coordinator asks every hospital for capacity each
  hour and sends ICU patients who can't get a bed here to a neighbour with room. The
  neighbour's free beds go down when it takes a patient.
- **Families see only approved changes.**
