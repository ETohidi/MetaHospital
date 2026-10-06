// Wall-clock time for the twin. The day starts on Wednesday 2026-09-16 at 08:00 and one
// tick is one hour. Ticks stay internal (stay lengths, discharge times); this is the one
// place that turns a tick into something a person reads. Pure arithmetic, so the
// viewer's timezone can't shift the clock.

export const DAY_START = { date: "2026-09-16", weekday: "Wednesday", hour: 8 };

// Starting from DAY_START's weekday.
const WEEKDAYS = ["Wednesday", "Thursday", "Friday", "Saturday", "Sunday", "Monday", "Tuesday"];

const pad = (n) => String(n).padStart(2, "0");
const mod = (n, m) => ((n % m) + m) % m;

function hourOf(tick) {
  return mod(DAY_START.hour + tick, 24);
}

/** "15:00" */
export function clock(tick) {
  return `${pad(hourOf(tick))}:00`;
}

/** "Wednesday 15:00" */
export function dayClock(tick) {
  const day = Math.floor((DAY_START.hour + tick) / 24);
  return `${WEEKDAYS[mod(day, 7)]} ${clock(tick)}`;
}

/** "15:00–16:00": the hour of care a plan made at this tick covers. */
export function hourRange(tick) {
  return `${clock(tick)}–${clock(tick + 1)}`;
}
