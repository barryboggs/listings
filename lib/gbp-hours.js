/**
 * Translate between the app's holiday-hours shape and Google Business
 * Profile's `specialHours.specialHourPeriods`, and merge an import into a
 * location's current periods. Pure functions, no I/O.
 *
 * App shape (same as the Semrush import):
 *   { type: "CLOSED" | "OPENED_ALL_DAY" | "RANGE" | "REMOVE", day: "YYYY-MM-DD", times?: [{ from: "HH:mm", to: "HH:mm" }] }
 *
 * Google shape (Business Information API v1, SpecialHourPeriod):
 *   { startDate: { year, month, day }, endDate: { year, month, day },
 *     closed?: true,
 *     openTime?: { hours, minutes? }, closeTime?: { hours, minutes? } }
 *   One period per open range; a closed day is one period with closed:true.
 *   A close at midnight is closeTime { hours: 24 }.
 */

export function isoToGoogleDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!m) throw new Error(`Bad date "${iso}" (want YYYY-MM-DD)`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

export function googleDateToIso(d) {
  if (!d || !d.year || !d.month || !d.day) return null;
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

function hhmmToGoogleTime(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ""));
  if (!m) throw new Error(`Bad time "${hhmm}" (want HH:mm)`);
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 24 || minutes > 59 || (hours === 24 && minutes > 0)) throw new Error(`Bad time "${hhmm}"`);
  return minutes ? { hours, minutes } : { hours };
}

export function googleTimeToHhmm(t) {
  if (!t) return null;
  return `${String(t.hours || 0).padStart(2, "0")}:${String(t.minutes || 0).padStart(2, "0")}`;
}

/** One app entry → zero or more Google periods. REMOVE yields none. */
export function appEntryToGooglePeriods(entry) {
  const date = isoToGoogleDate(entry.day);
  switch (entry.type) {
    case "REMOVE":
      return [];
    case "CLOSED":
      return [{ startDate: date, endDate: date, closed: true }];
    case "OPENED_ALL_DAY":
      return [{ startDate: date, endDate: date, openTime: { hours: 0 }, closeTime: { hours: 24 } }];
    case "RANGE": {
      const times = Array.isArray(entry.times) ? entry.times : [];
      if (times.length === 0) throw new Error(`RANGE entry for ${entry.day} has no times`);
      return times.map((t) => {
        const open = hhmmToGoogleTime(t.from);
        let close = hhmmToGoogleTime(t.to);
        // "00:00" as a closing time means midnight at the end of the day.
        if (close.hours === 0 && !close.minutes) close = { hours: 24 };
        return { startDate: date, endDate: date, openTime: open, closeTime: close };
      });
    }
    default:
      throw new Error(`Unknown holiday entry type "${entry.type}"`);
  }
}

/** Does this Google period cover the given ISO date? Handles multi-day spans. */
export function periodCoversDate(period, iso) {
  const start = googleDateToIso(period?.startDate);
  const end = googleDateToIso(period?.endDate) || start;
  if (!start) return false;
  return iso >= start && iso <= end;
}

/**
 * Apply an import to a location's current periods.
 *
 * For every entry, any existing period covering that date is dropped (a
 * multi-day period spanning the date goes too — Google has no way to
 * carve a day out of it). CLOSED / RANGE / OPENED_ALL_DAY entries then add
 * their periods. REMOVE adds nothing. Other dates are left exactly as they
 * were. Result is sorted by date, then open time.
 *
 * Periods that ended before `today` (ISO date, defaults to the current UTC
 * date) are not written back: Google hides expired special hours itself
 * and may reject a write that contains them. Pruning alone does not count
 * as a change.
 *
 * Returns { periods, changed } — `changed` is false when the result equals
 * the input (ignoring expired periods), so the caller can skip the write.
 */
export function mergeSpecialHours(currentPeriods, entries, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const current = (Array.isArray(currentPeriods) ? currentPeriods : []).filter((p) => {
    const end = googleDateToIso(p?.endDate) || googleDateToIso(p?.startDate);
    return !end || end >= today;
  });
  const touched = new Set(entries.map((e) => e.day));
  const kept = current.filter((p) => ![...touched].some((d) => periodCoversDate(p, d)));
  const added = entries.flatMap(appEntryToGooglePeriods);
  const periods = [...kept, ...added].sort(comparePeriods);
  const changed = normalize(periods) !== normalize([...current].sort(comparePeriods));
  return { periods, changed };
}

function comparePeriods(a, b) {
  const da = googleDateToIso(a.startDate) || "";
  const db = googleDateToIso(b.startDate) || "";
  if (da !== db) return da < db ? -1 : 1;
  const ta = a.closed ? -1 : (a.openTime?.hours || 0) * 60 + (a.openTime?.minutes || 0);
  const tb = b.closed ? -1 : (b.openTime?.hours || 0) * 60 + (b.openTime?.minutes || 0);
  return ta - tb;
}

function normalize(periods) {
  return JSON.stringify(periods.map((p) => ({
    s: googleDateToIso(p.startDate),
    e: googleDateToIso(p.endDate) || googleDateToIso(p.startDate),
    c: !!p.closed,
    o: p.closed ? null : googleTimeToHhmm(p.openTime),
    x: p.closed ? null : googleTimeToHhmm(p.closeTime),
  })));
}

/** Human-readable one-liner for a Google period, for previews and audit. */
export function describePeriod(p) {
  const s = googleDateToIso(p.startDate);
  const e = googleDateToIso(p.endDate);
  const when = e && e !== s ? `${s}→${e}` : s;
  if (p.closed) return `${when}: Closed`;
  return `${when}: ${googleTimeToHhmm(p.openTime)}–${googleTimeToHhmm(p.closeTime)}`;
}
