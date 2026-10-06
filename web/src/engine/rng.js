// Seeded pseudo-random numbers (mulberry32). The engine never touches Math.random, so a
// seed plus the same sequence of commands always replays the same day.

export function createRng(seed) {
  let a = seed >>> 0;

  function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [lo, hi], both inclusive (like Python's random.randint). */
  function randint(lo, hi) {
    return lo + Math.floor(random() * (hi - lo + 1));
  }

  function uniform(lo, hi) {
    return lo + (hi - lo) * random();
  }

  function choice(arr) {
    return arr[Math.floor(random() * arr.length)];
  }

  /** One key of {key: weight}, picked proportionally to its weight. Numeric keys come back as numbers. */
  function choices(weights) {
    const keys = Object.keys(weights);
    const total = keys.reduce((sum, k) => sum + weights[k], 0);
    const r = random() * total;
    let cumulative = 0;
    let picked = keys[keys.length - 1];
    for (const k of keys) {
      cumulative += weights[k];
      if (r < cumulative) {
        picked = k;
        break;
      }
    }
    return /^-?\d+(\.\d+)?$/.test(picked) ? Number(picked) : picked;
  }

  /** k distinct elements of arr, in random order (like Python's random.sample). */
  function sample(arr, k) {
    if (k > arr.length) throw new Error("sample larger than population");
    const pool = [...arr];
    for (let i = 0; i < k; i++) {
      const j = i + Math.floor(random() * (pool.length - i));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, k);
  }

  /** Standard normal via Box-Muller. */
  function normal() {
    const u1 = 1 - random(); // (0, 1], so the log is finite
    const u2 = random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  function lognormvariate(mu, sigma) {
    return Math.exp(mu + sigma * normal());
  }

  /** Knuth's multiplication method. */
  function poisson(mean) {
    if (mean <= 0) return 0;
    const limit = Math.exp(-mean);
    let k = 0;
    let p = 1;
    for (;;) {
      k += 1;
      p *= random();
      if (p <= limit) return k - 1;
    }
  }

  return { random, randint, uniform, choice, choices, sample, lognormvariate, poisson };
}

/**
 * A stable number in [0, 1) derived from its inputs, without advancing any generator.
 * Used for values that read-only queries compute (so looking at a view can't change the
 * simulation's future).
 */
export function hashFloat(...parts) {
  let h = 0x811c9dc5;
  for (const ch of parts.join("|")) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return createRng(h).random();
}
