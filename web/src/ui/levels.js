// The level model as content (concept section 2, Phase 1 step 3): for every level, who uses it,
// what they decide, what goes up, what goes to peers and what never leaves, each with its legal
// basis, plus the cadence and the KPI tiles the level declares. Rendered as the "Who uses this
// level, and what crosses its boundary" panel on every page. Germany/Berlin is the worked example.
// test/levels.test.js fails if a level lacks a field or a legal basis.

import { html } from "./dom.js";
import { prov } from "./page.js";

/** Every level must fill these fields (non-empty strings), plus kpis: string[] (1-5 tiles). */
export const LEVEL_FIELDS = [
  "name",
  "user",
  "decides",
  "up",
  "upBasis",
  "peers",
  "peersBasis",
  "never",
  "neverBasis",
  "cadence",
];

/** The ladder the UI shows, top to bottom (level names, never numbers). */
export const LEVEL_ORDER = ["world", "eu", "country", "city", "hospital", "unit"];

export const LEVELS = {
  world: {
    name: "World",
    route: "world",
    user: "WHO HQ and WHO Europe analysts; IHR Emergency Committee; emergency medical team and GOARN incident managers.",
    decides:
      "Declare a public health emergency of international concern (days); deploy emergency medical teams and supplies (hours to days); health-system investment advice (years).",
    up: "Nothing above. Publishes the Global Health Observatory and Disease Outbreak News.",
    upBasis: "WHO Constitution; IHR (2005)",
    peers: "UN agencies, the World Bank, ECDC and the EU, Africa CDC.",
    peersBasis: "Inter-agency agreements",
    never:
      "Patient data, except where IHR Art. 45 allows it as essential; hospital-level capacity, which this level does not hold.",
    neverBasis: "IHR Art. 45",
    cadence: "Events within 24 h (IHR Art. 6); SPAR yearly; statistics yearly with a lag of 1-2 years or more.",
    kpis: ["Countries with data", "Median beds per 1,000", "Share older than 3 years"],
  },
  eu: {
    name: "EU",
    route: null, // EU members only; the EU page comes in Phase 3
    user: "Health Security Committee member; ERCC duty officer; ECDC epidemiologist; HERA.",
    decides:
      "Coordinate national measures (days); match requested and offered ICU places, teams and transport (hours to days); joint procurement and stockpiles (months).",
    up: "To WHO.",
    upBasis: "Reg. (EU) 2022/2371 Art. 30",
    peers: "Third countries (UK, EEA, Switzerland) through ad-hoc EWRS access; WHO Europe.",
    peersBasis: "Reg. (EU) 2022/2371 Art. 18-19",
    never: "Patient identities, except purpose-bound EWRS contact tracing; hospital operational data.",
    neverBasis: "Reg. (EU) 2022/2371 Art. 27-28",
    cadence: "Alerts within 24 h; surveillance weekly; preparedness reports every 3 years.",
    kpis: ["Countries with a SARI feed", "Elevated or above", "Median occupancy"],
  },
  country: {
    name: "Country",
    route: "germany",
    user: "Ministry situation desk: BMG crisis staff, RKI situation centre (runs the DIVI register), GMLZ at the BBK.",
    decides:
      "National measures, ordinances and funding (days to years); national risk assessment (daily); coordinate cross-Land and international requests (hours).",
    up: "To the EU: EWRS alerts, ECDC surveillance. To WHO: events and the yearly SPAR; weekly hospital and ICU indicators only in a declared emergency.",
    upBasis: "IGV-DG §3-4; IHR Art. 6; Reg. (EU) 2022/2371 Art. 19",
    peers:
      "Other countries through the Health Security Committee, EWRS or bilaterally (ICU patients taken in from Italy and France in 2020).",
    peersBasis: "Reg. (EU) 2022/2371 Art. 21-23; 2020/C 111 I/01",
    never:
      "Patient identities (the RKI receives cases without names); hospital clinical details; critical-infrastructure security data.",
    neverBasis: "IfSG §11; GDPR Art. 9",
    cadence: "ICU daily by 12:00 (DIVI); notifiable diseases within 24 h; statistics yearly.",
    kpis: [
      "Adult ICU occupancy",
      "Free ICU beds",
      "7-day emergency reserve",
      "Free invasive ventilation",
      "Areas limited by staff",
    ],
  },
  city: {
    name: "Land · City",
    route: "berlin",
    user: "Senate health department (Land ministry and city authority in one), Kleeblatt-Ost contact point, ambulance dispatch (112).",
    decides:
      "Hospital plan: who provides which services with how many beds (years); stop planned surgery, activate disaster mode (days); which hospital receives this ambulance (minutes).",
    up: "Land aggregates to the federal ministry; Kleeblatt offer or need to the GMLZ. ICU data does not pass through the Land: hospitals report it per site to the RKI-run DIVI register.",
    upBasis: "KHG §6; IfSG §13(7)",
    peers:
      "Other Länder through the Kleeblatt contact points and the GMLZ; neighbouring dispatch centres (Berlin-Brandenburg mutual aid).",
    peersBasis: "Kleeblatt concept; Land rescue-service laws",
    never: "Patient data on any dashboard; hospitals' financial negotiations.",
    neverBasis: "GDPR Art. 9; §203 StGB",
    cadence: "Plan about every 5 years; ICU daily; dispatch in minutes; Kleeblatt decisions within hours.",
    kpis: [
      "Adult ICU occupancy",
      "Free ICU beds",
      "7-day emergency reserve",
      "Free invasive ventilation",
      "Areas limited by staff",
    ],
  },
  hospital: {
    name: "Hospital",
    route: null, // one route per hospital
    user: "Director, central bed manager, emergency department lead.",
    decides:
      "Open or close beds and cancel planned surgery (days); place admissions, transfers and discharges (hours).",
    up: "Free beds per capability and emergency department status to the city and dispatch, in real time; ICU status per site to the DIVI register, daily.",
    upBasis: "IfSG §13(7)",
    peers:
      "Status per capability (available, limited, not available, with a reason). An exact number only inside an offer that answers a request.",
    peersBasis: "Request and offer, a person accepts on both sides",
    never: "Patient records outside treatment, staff personal data, costs, contracts and pay.",
    neverBasis: "GDPR Art. 9; §203 StGB",
    cadence: "Internal in minutes; DIVI daily; statistics yearly.",
    kpis: ["Beds in use", "Free beds now", "Emergency department", "Without a staffed bed", "Next 6 h, net"],
  },
  unit: {
    name: "Unit",
    route: null,
    user: "Charge nurse, ICU attending, chief physician.",
    decides:
      "Which bed for whom, shift staffing and discharge readiness (hours); admit, refuse or step down (minutes).",
    up: "Counts only: free beds by type, closed beds, expected discharges, patients waiting. An ICU is one DIVI reporting area.",
    upBasis: "Internal to the hospital; ICU via IfSG §13(7)",
    peers:
      "Step-up and step-down transfers, borrowed staff or equipment inside the hospital. Patient data moves only with the patient.",
    peersBasis: "Treatment relationship",
    never: "Patient data to staff without a treatment relationship; staff health or performance data.",
    neverBasis: "GDPR Art. 9(2)(h); §203 StGB",
    cadence: "Continuous to hourly; staffing per shift.",
    kpis: ["Beds in use", "Free beds", "Closed: no staff", "Waiting", "Next 6 h"],
  },
};

/** One-line notes for levels with a local twist. */
const HERE_NOTE = {
  country:
    "The federal level does not plan hospitals (KHG §6); it sees the Länder totals and per-site ICU status as DIVI publishes it.",
  city: "Berlin is a city-state: the Land and the City level coincide in the Senate health department; its 12 districts form the local sub-level.",
  world: "Countries outside the EU have no EU level; WHO regional offices are a sub-view of this level.",
};

/**
 * "Who uses this level, and what crosses its boundary", with the level ladder on top.
 * @param {string} key  one of LEVEL_ORDER
 * @param {{place?: string, links?: Object<string, string>}} opts  links: level key -> route token for ladder links
 */
export function levelsPanel(key, { place = "", links = {} } = {}) {
  const L = LEVELS[key];
  if (!L) return "";
  const note = HERE_NOTE[key] ? ` ${HERE_NOTE[key]}` : "";
  return html`
    <section class="pane levels" aria-labelledby="levels-title">
      <header class="pane-head">
        <div>
          <h2 id="levels-title">Who uses this level, and what crosses its boundary</h2>
          <p>
            ${place ? `${place} at ${L.name} level.` : `${L.name} level.`}${note} Logging and purpose binding are the
            required behaviour of a real deployment: illustrated here, not enforced.
          </p>
        </div>
        ${prov("illustrative", { title: "Describes the real reporting rules; the static site cannot enforce them" })}
      </header>
      <ol class="levels-ladder" aria-label="Levels">
        ${LEVEL_ORDER.map((k) => {
          const lv = LEVELS[k];
          if (k === key) return html`<li aria-current="step" class="is-here">${lv.name}</li>`;
          const token = links[k] ?? lv.route;
          return token ? html`<li><a href="#${token}">${lv.name}</a></li>` : html`<li>${lv.name}</li>`;
        })}
      </ol>
      <div class="levels-grid">
        <div>
          <h3>Who uses it</h3>
          <p>${L.user}</p>
          <p class="levels-sub">${L.decides}</p>
        </div>
        <div>
          <h3>Shares up</h3>
          <p>${L.up}</p>
          <p class="levels-basis">${L.upBasis}</p>
        </div>
        <div>
          <h3>With peers</h3>
          <p>${L.peers}</p>
          <p class="levels-basis">${L.peersBasis}</p>
        </div>
        <div class="is-never">
          <h3>Never leaves</h3>
          <p>${L.never}</p>
          <p class="levels-basis">${L.neverBasis}</p>
        </div>
      </div>
      <footer class="pane-foot">
        <span><b>Cadence:</b> ${L.cadence}</span>
      </footer>
    </section>
  `;
}
