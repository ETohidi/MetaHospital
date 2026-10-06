// Small shared helpers for building HTML strings safely, plus formatters and the
// visual vocabulary (chips, meters, confidence bars, acuity badges) every view uses.

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

class Raw {
  constructor(s) {
    this.s = String(s);
  }
  toString() {
    return this.s;
  }
}

/** Mark a string as already-safe HTML so html`` doesn't escape it. */
export function raw(s) {
  return new Raw(s);
}

function interpolate(v) {
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(interpolate).join("");
  if (v === null || v === undefined || v === false) return "";
  return esc(v);
}

/** Tagged template: escapes every interpolated value unless it came from raw() or html``. */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += interpolate(values[i]) + strings[i + 1];
  return raw(out);
}

// -- formatters ---------------------------------------------------------------
export const pct = (x) => `${Math.round((x || 0) * 100)}%`;
export const conf2 = (x) => (x ?? 0).toFixed(2);
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Utilisation band used everywhere: ok below 85%, warn to 95%, crit above 95%. */
export function utilTone(fraction) {
  if (fraction > 0.95) return "crit";
  if (fraction > 0.85) return "warn";
  return "ok";
}

export const UTIL_LABEL = { ok: "Normal", warn: "Busy", crit: "Critical" };

/** Confidence band: matches the plan card's "review carefully" threshold of 0.5. */
export function confTone(c) {
  if (c < 0.5) return "crit";
  if (c < 0.7) return "warn";
  return "ok";
}

// -- visual vocabulary ----------------------------------------------------------
export function chip(text, tone = "", { plain = false, title = "" } = {}) {
  const cls = ["chip", tone && `chip-${tone}`, plain && "chip-plain"].filter(Boolean).join(" ");
  return html`<span class="${cls}"${title ? raw(` title="${esc(title)}"`) : ""}>${text}</span>`;
}

export function meter(fraction, { label = "" } = {}) {
  const tone = utilTone(fraction);
  const width = Math.max(0, Math.min(1, fraction)) * 100;
  const value = Math.round(fraction * 100);
  // A unit can be over 100% during an emergency, so the range stretches to include it.
  return html`<div class="meter is-${tone}" role="meter" aria-valuemin="0" aria-valuemax="${Math.max(100, value)}" aria-valuenow="${value}" aria-valuetext="${value}% of usable beds" aria-label="${
    label || "Utilisation"
  }"><span style="width:${width.toFixed(1)}%"></span></div>`;
}

export function confBar(c) {
  const tone = confTone(c ?? 0);
  const width = Math.max(0, Math.min(1, c ?? 0)) * 100;
  return html`<span class="conf is-${tone}" title="Confidence ${conf2(c)}"><span class="conf-track"><span class="conf-fill" style="width:${width.toFixed(
    0,
  )}%"></span></span>${conf2(c)}</span>`;
}

export function acuity(a) {
  const n = Number(a);
  if (!Number.isFinite(n) || n < 1) return html`<span class="faint">—</span>`;
  return html`<span class="tri tri-${n}" title="Acuity ${n} of 5">${n}</span>`;
}

export const ACUITY_LABEL = {
  1: "non-urgent",
  2: "standard",
  3: "urgent",
  4: "very urgent",
  5: "immediate",
};

/** CSS colour for an acuity, for SVG fills. */
export const acuityColor = (a) => `var(--tri-${Math.max(1, Math.min(5, Number(a) || 1))})`;
