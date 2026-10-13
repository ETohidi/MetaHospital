// Wall-clock time for the twin, always in German time (Europe/Berlin, with summer and winter
// time). A clock starts at a fixed moment and one tick is one hour. Ticks stay internal (stay
// lengths, discharge times); this is the one place that turns a tick into something a person
// reads. The start moment is an input, so the engine never reads the current time itself:
// the site passes "now", tests use DEFAULT_START_MS, and a seed still replays the same day.

export const TIME_ZONE = "Europe/Berlin";
export const TIME_ZONE_LABEL = "German time";
const HOUR_MS = 3_600_000;

/** Wednesday 16 September 2026, 08:00 in Germany (06:00 UTC, summer time). */
export const DEFAULT_START_MS = Date.UTC(2026, 8, 16, 6, 0, 0);

/** The hour that starts at `ms`, rounded down. Germany's UTC offset is a whole number of hours. */
export const startOfHour = (ms) => Math.floor(ms / HOUR_MS) * HOUR_MS;

const PARTS = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  weekday: "long",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function partsAt(ms) {
  const p = {};
  for (const { type, value } of PARTS.formatToParts(ms)) p[type] = value;
  return p;
}

/**
 * A clock that starts at `startMs` (epoch ms, on the hour). Every label is German local time.
 * Parts are cached per tick: the same few hundred ticks are formatted over and over.
 */
export function makeClock(startMs = DEFAULT_START_MS) {
  const cache = new Map();
  const at = (tick) => {
    let p = cache.get(tick);
    if (!p) {
      p = partsAt(startMs + tick * HOUR_MS);
      if (cache.size > 2000) cache.clear();
      cache.set(tick, p);
    }
    return p;
  };
  const time = (tick) => `${at(tick).hour}:${at(tick).minute}`;
  // Calendar day number of the tick in Germany, for "today / yesterday / tomorrow".
  const dayNumber = (tick) => {
    const p = at(tick);
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) / 86_400_000;
  };
  const firstDay = dayNumber(0);
  return {
    startMs,
    timeZone: TIME_ZONE,
    /** "15:00" */
    time,
    /** "Wednesday 15:00" */
    dayTime: (tick) => `${at(tick).weekday} ${time(tick)}`,
    /** "15:00–16:00": the hour of care a plan made at this tick covers. */
    hourRange: (tick) => `${time(tick)}–${time(tick + 1)}`,
    /** "16 Sep 2026" */
    date: (tick) => `${Number(at(tick).day)} ${MONTHS[Number(at(tick).month) - 1]} ${at(tick).year}`,
    /** Hour of the day, 0-23. */
    hour: (tick) => Number(at(tick).hour),
    /** Calendar days since the clock's first day: 0 on the first day, 1 the day after. */
    dayIndex: (tick) => dayNumber(tick) - firstDay,
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// The default clock, for code and tests that don't carry a twin's own clock.
const DEFAULT_CLOCK = makeClock(DEFAULT_START_MS);

/** "15:00" on the default clock. */
export const clock = (tick) => DEFAULT_CLOCK.time(tick);
/** "Wednesday 15:00" on the default clock. */
export const dayClock = (tick) => DEFAULT_CLOCK.dayTime(tick);
/** "15:00–16:00" on the default clock. */
export const hourRange = (tick) => DEFAULT_CLOCK.hourRange(tick);
