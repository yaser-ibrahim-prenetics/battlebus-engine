import type { Window } from "./types";
const DAY = 86_400_000;

function dateOnly(value: string): number {
  const time = Date.parse(value);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(time) ||
    new Date(time).toISOString().slice(0, 10) !== value
  )
    throw new Error("Reconciliation dates must be valid YYYY-MM-DD UTC dates");
  return time;
}

/** Inclusive manual dates; automatic runs cover the previous complete UTC day. */
export function reconciliationWindow(from?: string, to?: string, now = new Date()): Window {
  if (Boolean(from) !== Boolean(to)) throw new Error("Provide both dateFrom and dateTo");
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = from ? dateOnly(from) : today - DAY;
  const end = to ? dateOnly(to) + DAY : today;
  if (start >= end || end > today || end - start > 31 * DAY)
    throw new Error("Use 1–31 complete UTC days");
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

export function inWindow(value: string, window: Window): boolean {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error("Provider returned an invalid timestamp");
  return time >= Date.parse(window.start) && time < Date.parse(window.end);
}

export function* days(window: Window): Generator<Window> {
  for (let start = Date.parse(window.start); start < Date.parse(window.end); start += DAY)
    yield {
      start: new Date(start).toISOString(),
      end: new Date(Math.min(start + DAY, Date.parse(window.end))).toISOString(),
    };
}
