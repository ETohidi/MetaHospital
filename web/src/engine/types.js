// Shapes shared by the engine and the views. Documentation only - nothing to import.
//
// The engine runs in the browser, is deterministic for a given seed, and is driven
// through the Twin facade in twin.js; it never touches the DOM, Math.random or Date.
//
// Levels of the twin and where their data comes from:
//   Earth / Germany / Berlin -> Snapshot.hospitals (+ nearbyCapacity)
//   Hospital (own)           -> Snapshot.units / patients / pendingBundle, twin.log(), twin.family()
//   Hospital (neighbour)     -> Snapshot.hospitals[i], twin.hospitalHistory(), twin.hospitalReports()
//   Unit (own hospital only) -> Snapshot.units[u], patients, twin.unitHistory(), twin.unitPlans()

/**
 * @typedef {"ED"|"ICU"|"Ward"} Unit
 *
 * @typedef {Object} Patient
 * @property {string} id                 e.g. "p044"
 * @property {Unit} unit                 where the patient physically is now
 * @property {number} acuity             1..5, 5 = most severe (Manchester Triage colours in the UI)
 * @property {string} condition          trauma | cardiac | respiratory | stroke | infection | other
 * @property {number} admitTick          tick the patient entered their current unit
 * @property {number} expectedDischargeTick
 * @property {string} expectedDischargeTime  "HH:MM"
 * @property {number|null} bed           1..bedsStaffed, or null = no staffed bed free (hallway / overflow)
 * @property {boolean} surge             arrived with the emergency scenario
 *
 * @typedef {Object} QueueItem           a patient waiting to move INTO this unit
 * @property {string} patientId
 * @property {Unit} from
 * @property {number} acuity
 * @property {string} condition
 * @property {number} waitingTicks       hours waited so far
 *
 * @typedef {Object} UnitSnapshot
 * @property {Unit} name
 * @property {number} bedsTotal          physical beds
 * @property {number} bedsStaffed        usable today (limited by nurses on shift)
 * @property {number} bedsOccupied       patients in the unit (can exceed bedsStaffed during a surge)
 * @property {QueueItem[]} queue
 * @property {string[]} recentRejections active charge-nurse rejection reasons (fade after a few hours)
 *
 * @typedef {Object} UnitBeds
 * @property {number} bedsTotal
 * @property {number} bedsStaffed
 * @property {number} bedsOccupied
 *
 * @typedef {Object} HospitalSummary
 * @property {string} id                 places.js id, e.g. "kreuzberg"
 * @property {string} name
 * @property {boolean} isOwn
 * @property {{ED: UnitBeds, ICU: UnitBeds, Ward: UnitBeds}} units
 *
 * @typedef {Object} Capacity            a hospital's answer to the Regional coordinator
 * @property {string} hospital
 * @property {{ICU: number, Ward: number}} canAccept
 * @property {string} validUntil         "HH:MM"
 * @property {string[]} conditionsPreferred
 * @property {number} confidence         0..1
 * @property {string} note
 *
 * @typedef {Object} Action
 * @property {"accept_transfer"|"defer_transfer"|"expedite_discharge"|"open_overflow"|"request_beds"|"divert_ed"|"defer_elective"|"divert_to"} type
 * @property {string} [patientId]
 * @property {Unit} [from]
 * @property {number} [targetTick]
 * @property {number} [beds]
 * @property {string} [urgency]
 * @property {number} [confidence]
 * @property {string} [reason]
 * @property {string} [hospital]         receiving hospital, for divert_to
 *
 * @typedef {Object} Proposal
 * @property {Unit} unit
 * @property {string} author             "ED planner" | "ICU planner" | "Ward planner" | "Regional coordinator"
 * @property {Action[]} actions
 * @property {string} rationale
 * @property {number} confidence
 * @property {string[]} risks
 *
 * @typedef {Object} SafetyEntry
 * @property {Unit} unit
 * @property {string} author
 * @property {Action} action
 * @property {boolean} blocked
 * @property {string|null} rule          the rule's plain-text statement when blocked
 *
 * @typedef {Object} PlanRow             one row of the plan table
 * @property {Unit} unit
 * @property {string} author
 * @property {string} patientId          "—" for unit-level actions (divert_ed, open_overflow, ...)
 * @property {string} condition          "—" when not about one patient
 * @property {number|null} acuity
 * @property {string} movement           e.g. "ED → ICU", "→ Rixdorf Hospital", "diverted", "+2 overflow beds"
 * @property {string} actionType
 * @property {number} confidence
 * @property {string} reason
 *
 * @typedef {Object} Bundle              the Coordinator's plan for one hour
 * @property {number} id
 * @property {number} tick
 * @property {string} hourRange          "12:00–13:00" (en dash)
 * @property {string} summary          "12:00–13:00: 3/4 actions cleared by the Safety check" or
 *                                      "12:00–13:00: no actions this hour"
 * @property {Proposal[]} proposals      only actions that cleared the safety check
 * @property {SafetyEntry[]} safety      every action that was checked, allowed or blocked
 * @property {PlanRow[]} rows
 * @property {number|null} overallConfidence   minimum over rows
 * @property {Capacity[]} nearbyCapacity
 * @property {{ED: number, ICU: number, Ward: number}} before   occupied beds now
 * @property {{ED: number, ICU: number, Ward: number}} after    projected if approved
 * @property {"pending"|"approved"|"rejected"|"expired"} status
 * @property {string|null} reason        rejection reason
 * @property {string|null} decidedTime   "HH:MM" of the decision / expiry
 *
 * @typedef {Object} LogEntry
 * @property {number} tick
 * @property {string} time
 * @property {string} actor              "ED planner", "Coordinator", "Safety check", "Regional coordinator",
 *                                       a hospital name, "Simulation" (the simulation itself) or "Charge nurse"
 * @property {string} text
 * @property {"info"|"warn"|"block"|"decision"} level
 *
 * @typedef {Object} FamilyMessage
 * @property {number} tick
 * @property {string} time
 * @property {string} text
 *
 * @typedef {Object} HistoryRow
 * @property {number} tick
 * @property {string} time
 * @property {string} dayTime           "Thursday 09:00", for charts that span more than a day
 * @property {number} inUse
 * @property {number} usable
 * @property {number} arrivals          new patients admitted straight into this unit
 * @property {number} discharges        patients who left the hospital from this unit (incl. ED boarders transferred out)
 * @property {number} queueLength
 * @property {number} surgeArrivals     of arrivals, how many came with the emergency (left out of the projection)
 * @property {number} transfersIn       patients moved into this unit by an approved plan this hour (accept_transfer)
 * @property {number} transfersOut      patients moved out by an approved plan this hour: to another unit
 *                                      (accept_transfer, counted for the queue's `from`) or hospital (divert_to)
 *
 * Projection (state.projection): in use now, then each hour minus the scheduled discharges of
 * patients not waiting in a queue, plus the average net inflow over the history
 * (arrivals - surgeArrivals + transfersIn - transfersOut).
 *
 * @typedef {Object} ProjectionRow
 * @property {number} tick
 * @property {string} time
 * @property {number} projectedInUse
 *
 * @typedef {Object} HospitalHistoryRow
 * @property {number} tick
 * @property {string} time
 * @property {string} dayTime           "Thursday 09:00"
 * @property {{ED: number, ICU: number, Ward: number}} freeBeds
 *
 * @typedef {Object} HospitalReport
 * @property {string} hourRange
 * @property {{ICU: number, Ward: number}} canAccept
 * @property {number} confidence
 * @property {string} note
 *
 * @typedef {Object} Census            twin.census(unit): what a unit planner reads
 * @property {number} tick
 * @property {string} time
 * @property {Unit} unit
 * @property {number} bedsTotal
 * @property {number} bedsOccupied
 * @property {number} bedsStaffed
 * @property {{patientId: string, acuity: number, condition: string, etaTime: string}[]} expectedDischarges  soonest 10
 * @property {QueueItem[]} queue
 * @property {{unit: Unit, beds: number, urgency: string}[]} requestsFromOthers
 * @property {string[]} recentRejections
 * @property {string|null} surge
 * @property {string|null} hint         set while a remembered rejection mentions a nearby hospital
 *
 * @typedef {Object} HospitalCensus      twin.hospitalCensus(name): what a hospital is asked
 * @property {string} hospital
 * @property {string} time
 * @property {{ED: number, ICU: number, Ward: number}} freeBeds   usable minus occupied, never below 0
 * @property {{ICU: number, Ward: number}} expectedDischarges3h
 * @property {string|null} emergency
 *
 * @typedef {Object} Snapshot            everything a view needs for one render, JSON-safe
 * @property {number} tick
 * @property {string} time               "12:00"
 * @property {string} dayTime            "Wednesday 12:00"
 * @property {string} hourRange          "12:00–13:00"
 * @property {number} seed
 * @property {{ED: UnitSnapshot, ICU: UnitSnapshot, Ward: UnitSnapshot}} units   own hospital
 * @property {Patient[]} patients        own hospital, sorted by id
 * @property {string|null} surge         e.g. "bus accident, 20 casualties" while active
 * @property {number} surgeTicksRemaining
 * @property {number} edDivertHoursRemaining   hours of halved ambulance arrivals left after an approved divert_ed
 * @property {{unit: Unit, beds: number, urgency: string, tick: number}[]} pendingRequests
 * @property {HospitalSummary[]} hospitals   own hospital first
 * @property {Object<string, Capacity>} nearbyCapacity   latest answers, keyed by hospital name
 * @property {{from: Unit, to: Unit, patientId: string}[]} recentTransfers  from the last approval
 * @property {Unit[]} recentDischarges   units that discharged someone in the last hour
 * @property {Unit[]} recentProposals    units whose planner proposed in the last hour
 * @property {Bundle|null} pendingBundle at most one plan waits for a decision
 * @property {number} bundleCount        plans kept (the newest BUNDLE_LIMIT = 168, a week of hours)
 */

// -- Real open data (not the engine): written by tools/build-data.mjs, loaded by src/data/real.js ---------
// The engine never reads these; views get them as ctx.data, with ctx.dataState "loading"|"ready"|"failed".
/**
 * @typedef {Object} Provenance          applies to every value in the file that carries it
 * @property {"Live"|"Official"} kind
 * @property {string} source
 * @property {string} url
 * @property {string} licence            e.g. "CC BY 4.0"
 * @property {string|null} asOf          "YYYY-MM-DD": report day (DIVI) or last update (World Bank)
 * @property {string|null} generatedAt   ISO time the file was built
 *
 * @typedef {Object} IcuFigures          one DIVI row, adults; null where DIVI reports NA
 * @property {number} areas              reporting areas (Meldebereiche)
 * @property {number} occupied
 * @property {number} free
 * @property {number} reserve            7-day emergency reserve
 * @property {number} ventFree           free invasive ventilation places
 * @property {{regular: number, partly: number, limited: number, noStatement: number}} status   areas per operating status
 * @property {{staff: number, material: number, room: number, equipment: number}} limits       areas per limitation reason
 *
 * @typedef {{date: string, occupied: number, free: number}} IcuDay
 *
 * @typedef {Object} GermanyIcu          web/data/de-icu.json
 * @property {string} asOf
 * @property {Provenance} meta
 * @property {"adults"} group
 * @property {IcuFigures & {series: IcuDay[]}} national          the RKI national file
 * @property {(IcuFigures & {id: string, name: string, series: IcuDay[]})[]} laender   16, id "01".."16"
 *
 * @typedef {{value: number, year: number}} YearValue
 *
 * @typedef {Object} WorldBeds           web/data/world.json
 * @property {Provenance} meta
 * @property {{iso3: string, name: string, beds: YearValue|null, population: YearValue|null}[]} countries   null = Unknown, never 0
 *
 * @typedef {Object} RealData            what loadRealData() resolves
 * @property {GermanyIcu|null} de
 * @property {WorldBeds|null} world
 * @property {Object<string, Error>} errors   per file that failed
 */

export {};
