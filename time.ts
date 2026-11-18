/** Dates and times as the reader lives them: Europe/Stockholm, whatever the host's zone. */

export const ZONE = "Europe/Stockholm";

const PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export type WallClock = { date: string; time: string };

/** Stockholm's date and time at an instant. */
export function stockholmAt(instant: Date): WallClock {
  const parts: Record<string, string> = {};
  for (const part of PARTS.formatToParts(instant)) parts[part.type] = part.value;
  return {
    date: `${parts["year"]}-${parts["month"]}-${parts["day"]}`,
    time: `${parts["hour"]}:${parts["minute"]}`,
  };
}

export function today(now = new Date()): string {
  return stockholmAt(now).date;
}

/**
 * A Hub timestamp as Stockholm wall-clock time. Hub sends wall-clock strings
 * without an offset (kept as they are); one with an offset or `Z` is an instant.
 */
export function wallClock(value: unknown): WallClock | null {
  if (typeof value !== "string") return null;
  const match =
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(
      value.trim(),
    );
  if (match === null) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? { date: value.trim(), time: "00:00" } : null;
  }
  if (match[3] === undefined) return { date: match[1] ?? "", time: match[2] ?? "" };
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? null : stockholmAt(instant);
}

/** `YYYY-MM-DD` plus `days`, in calendar days (no time zone involved). */
export function addDays(date: string, days: number): string {
  const moved = new Date(`${date}T00:00:00Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
}

export function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return addDays(value, 0) === value;
}

/** Monday of the week the date falls in. */
export function mondayOf(date: string): string {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Minutes Stockholm is ahead of UTC at noon of `date` (60 in winter, 120 in summer). */
export function stockholmOffsetMinutes(date: string): number {
  const noon = new Date(`${date}T12:00:00Z`);
  const local = stockholmAt(noon);
  const asUtc = Date.parse(`${local.date}T${local.time}:00Z`);
  return Math.round((asUtc - noon.getTime()) / 60_000);
}

export function formatDay(date: string): string {
  const name = new Intl.DateTimeFormat("sv-SE", { timeZone: "UTC", weekday: "long" }).format(
    new Date(`${date}T00:00:00Z`),
  );
  return `${name} ${date}`;
}
