// Template messages for patients' families, generated only from actions of an APPROVED
// plan that actually took effect.

import { clock } from "./clock.js";

export const TEMPLATES = {
  accept_transfer: (m) =>
    `Patient ${m.patientId} is moving from ${m.fromUnit} to ${m.unit} around ${m.eta}. ` +
    `Confidence: ${m.confLabel}. Their records go with them.`,
  expedite_discharge: (m) =>
    `Patient ${m.patientId} in ${m.unit} may be discharged earlier than planned, around ${m.eta}. ` +
    `Confidence: ${m.confLabel}.`,
  open_overflow: (m) => `${m.unit} is opening ${m.beds} additional ${m.beds === 1 ? "bed" : "beds"} to handle demand. Confidence: ${m.confLabel}.`,
  request_beds: (m) => `${m.unit} has requested additional bed capacity from other units. Confidence: ${m.confLabel}.`,
  divert_ed: (m) => `The Emergency Department is temporarily diverting incoming ambulances. Confidence: ${m.confLabel}.`,
  defer_elective: (m) => `An elective admission to ${m.unit} has been postponed. Confidence: ${m.confLabel}.`,
  defer_transfer: (m) => `A transfer to ${m.unit} has been deferred. Confidence: ${m.confLabel}.`,
  divert_to: (m) =>
    `Patient ${m.patientId} is being transferred to ${m.hospital}, which has confirmed it can take them. ` +
    "Their records go with them.",
};

export function confidenceLabel(confidence) {
  if (confidence >= 0.7) return "high";
  if (confidence >= 0.4) return "medium";
  return "low";
}

/**
 * @param {object} bundle
 * @param {(action: object) => boolean} [isApplied]  skip actions that didn't take effect
 * @returns {string[]}
 */
export function generateMessages(bundle, isApplied = () => true) {
  const messages = [];
  for (const p of bundle.proposals) {
    for (const a of p.actions) {
      const template = TEMPLATES[a.type];
      if (!template || !isApplied(a)) continue;
      messages.push(
        template({
          patientId: a.patientId ?? "",
          fromUnit: a.from ?? "",
          unit: p.unit,
          hospital: a.hospital ?? "",
          eta: clock(a.targetTick ?? bundle.tick + 1),
          beds: a.beds ?? "",
          confLabel: confidenceLabel(a.confidence ?? p.confidence),
        }),
      );
    }
  }
  return messages;
}
