/**
 * @dankdash/dispensaries public surface.
 *
 * Currently exports hours-of-operation arithmetic. The compliance engine
 * imports `effectiveWindowFor` from here for its sale-hours rule, and the
 * listings/menu/search surfaces import `isOpenAt` and `nextOpenAt`.
 *
 * Additions to this barrel are a workspace-wide contract change; bump the
 * package version and re-test downstream consumers (@dankdash/compliance,
 * apps/api) before landing.
 */
export {
  effectiveWindowFor,
  isOpenAt,
  lookupHoursForDay,
  nextOpenAt,
  parseHourMinute,
  type DayHours,
  type DispensaryHours,
  type EffectiveWindow,
  type HourMinute,
  type StateSalesCap,
  type Weekday,
} from './hours.js';
