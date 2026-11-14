/** Calendar-date helpers. Dates are "YYYY-MM-DD" strings, so no timezone drift. */

export type Frequency = "once" | "weekly" | "fortnightly" | "monthly";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Today's calendar date in the bank's timezone. */
export function todayIn(timezone: string, now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Adds months while keeping the original day of the month where it exists.
 * A payment anchored on the 31st runs on the 30th (or 28th/29th) in shorter months
 * and returns to the 31st afterwards.
 */
export function addMonths(date: string, months: number, anchorDay: number): string {
  const [y, m] = date.split("-").map(Number) as [number, number];
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(anchorDay, lastDay));
  return first.toISOString().slice(0, 10);
}

/** The run date after `date`, or null when the schedule has no further runs. */
export function nextRunDate(date: string, frequency: Frequency, anchorDay: number): string | null {
  switch (frequency) {
    case "once":
      return null;
    case "weekly":
      return addDays(date, 7);
    case "fortnightly":
      return addDays(date, 14);
    case "monthly":
      return addMonths(date, 1, anchorDay);
  }
}
