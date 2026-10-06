// The hospital network and the places around it. Hospital names are fictional; the
// bed numbers they report come from the simulation, never from a real hospital.

export const OWN_HOSPITAL_ID = "kreuzberg";

// seed: unit -> [beds_total, beds_staffed (usable today), beds_occupied]
export const HOSPITALS = [
  {
    id: "kreuzberg",
    name: "Klinikum Kreuzberg",
    short: "Kreuzberg",
    isOwn: true,
    district: "Friedrichshain-Kreuzberg",
    lat: 52.497,
    lon: 13.39,
    seed: { ED: [30, 28, 22], ICU: [20, 19, 17], Ward: [80, 76, 68] },
  },
  {
    id: "spreebogen",
    name: "Spreebogen Klinik",
    short: "Spreebogen",
    isOwn: false,
    district: "Mitte",
    lat: 52.523,
    lon: 13.368,
    seed: { ED: [25, 24, 16], ICU: [15, 14, 10], Ward: [60, 58, 40] },
  },
  {
    id: "rixdorf",
    name: "Rixdorf Hospital",
    short: "Rixdorf",
    isOwn: false,
    district: "Neukölln",
    lat: 52.473,
    lon: 13.444,
    seed: { ED: [20, 19, 13], ICU: [10, 10, 7], Ward: [50, 48, 32] },
  },
];

export const HOSPITAL_BY_ID = Object.fromEntries(HOSPITALS.map((h) => [h.id, h]));
export const HOSPITAL_BY_NAME = Object.fromEntries(HOSPITALS.map((h) => [h.name, h]));
export const OWN_HOSPITAL = HOSPITAL_BY_ID[OWN_HOSPITAL_ID];

export const UNITS = ["ED", "ICU", "Ward"];
export const UNIT_IDS = { ED: "ed", ICU: "icu", Ward: "ward" };
export const UNIT_BY_ID = { ed: "ED", icu: "ICU", ward: "Ward" };
export const UNIT_LABEL = { ED: "Emergency Department", ICU: "Intensive Care", Ward: "General Ward" };

export const BERLIN = { name: "Berlin", lat: 52.52, lon: 13.405, areaKm2: 891 };

// Other German cities, shown on the Germany level as not yet connected to the network.
export const OTHER_CITIES = [
  { name: "Hamburg", lat: 53.551, lon: 9.994 },
  { name: "München", lat: 48.137, lon: 11.575 },
  { name: "Köln", lat: 50.938, lon: 6.96 },
  { name: "Frankfurt", lat: 50.11, lon: 8.682 },
  { name: "Leipzig", lat: 51.34, lon: 12.375 },
  { name: "Dresden", lat: 51.05, lon: 13.738 },
];
