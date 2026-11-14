const aud = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" });

export const money = (cents: number) => aud.format(cents / 100);
export const signedMoney = (cents: number) => (cents > 0 ? `+${money(cents)}` : money(cents).replace("-", "−"));

/**
 * Turns what someone typed ("1,250.5", "$40") into whole cents without floating-point maths.
 * Returns null if it isn't a valid amount.
 */
export function parseAmount(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, "");
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

const dayFormat = new Intl.DateTimeFormat("en-AU", { weekday: "short", day: "numeric", month: "short" });
const dayWithYear = new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric" });
const timeFormat = new Intl.DateTimeFormat("en-AU", { hour: "numeric", minute: "2-digit" });

const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** "Today", "Yesterday", or a date, for grouping history. */
export function dayLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (localDay(d) === localDay(now)) return "Today";
  if (localDay(d) === localDay(yesterday)) return "Yesterday";
  return d.getFullYear() === now.getFullYear() ? dayFormat.format(d) : dayWithYear.format(d);
}

export const timeLabel = (iso: string) => timeFormat.format(new Date(iso));

/** Formats a YYYY-MM-DD calendar date. */
export function dateLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const local = new Date(y, m - 1, d);
  return local.getFullYear() === new Date().getFullYear() ? dayFormat.format(local) : dayWithYear.format(local);
}

export const accountNumber = (bsb: string, number: string) => `${bsb} ${number.replace(/(\d{4})(?=\d)/g, "$1 ")}`;

export const frequencyLabel = {
  once: "Once",
  weekly: "Every week",
  fortnightly: "Every fortnight",
  monthly: "Every month",
} as const;
