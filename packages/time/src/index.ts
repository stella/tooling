// Named duration constants for elapsed-time math (TTLs, staleness
// thresholds, rolling windows, polling intervals), and the calendar-date
// helpers in `./dates`.
//
// The two are not interchangeable. `DAY_IN_MS` is a DURATION: a calendar day
// is not always 24 hours (a DST transition day is 23 or 25), so computing
// another calendar date goes through `addDays`, never through adding
// `DAY_IN_MS`.

// Use the runtime's native implementation when it exists and the same
// side-effect-free implementation everywhere else. Consumers import this value
// explicitly; this package never installs an ambient Temporal global.
export { Temporal } from "temporal-polyfill/full";

/** 24 hours in milliseconds. A duration, not a calendar day. */
export const DAY_IN_MS: number = 24 * 60 * 60 * 1000;

export {
  addDays,
  isIsoDateString,
  parseIsoDateLocal,
  parsePlainDate,
} from "./dates.js";
export { parseTimeZoneId } from "./time-zone.js";
export type { TimeZoneId } from "./time-zone.js";
export { todayFor } from "./today.js";
