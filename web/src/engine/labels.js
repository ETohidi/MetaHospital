// Plain-language names for the planners' action types, for log lines and the plan card.
export const ACTION_LABEL = {
  accept_transfer: "take a waiting patient",
  defer_transfer: "defer a transfer",
  expedite_discharge: "discharge early",
  open_overflow: "open overflow beds",
  request_beds: "ask other units for beds",
  divert_ed: "divert ambulances",
  defer_elective: "postpone an elective admission",
  divert_to: "send to another hospital",
};

export const actionLabel = (type) => ACTION_LABEL[type] ?? type;
