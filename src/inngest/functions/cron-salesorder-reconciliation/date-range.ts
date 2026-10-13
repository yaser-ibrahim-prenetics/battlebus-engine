export function ymdToUtcDate(ymd: string): Date {
  const parts = ymd.split("-").map((x) => parseInt(x, 10));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`Invalid YYYY-MM-DD: ${ymd}`);
  }
  const [y, m, d] = parts;
  return new Date(Date.UTC(y, m - 1, d));
}

export function utcDateToYmd(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function addCalendarDaysYmd(ymd: string, deltaDays: number): string {
  const d = ymdToUtcDate(ymd);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return utcDateToYmd(d);
}

/** UTC midnight on `ymd` as ISO string. */
export function utcMidnightIso(ymd: string): string {
  return ymdToUtcDate(ymd).toISOString();
}

/**
 * True if Shopify's order {@link createdAtIso} falls in the half-open UTC
 * window `[fromIso, beforeIso)`.
 *
 * The GraphQL `orders(query: "created_at:…")` filter can still return neighbors;
 * we always enforce the intended UTC range using the API's `createdAt` field.
 */
export function orderCreatedAtInUtcHalfOpenWindow(
  createdAtIso: string,
  fromIso: string,
  beforeIso: string
): boolean {
  const t = Date.parse(createdAtIso);
  if (Number.isNaN(t)) return false;
  const startMs = Date.parse(fromIso);
  const endMs = Date.parse(beforeIso);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return false;
  return t >= startMs && t < endMs;
}

/** Last closed UTC calendar day (for the cron at 00:00 UTC). */
export function getPreviousUtcDayRange(now: Date): {
  fromIso: string;
  dateEndExclusiveIso: string;
  fromDate: string;
  toDate: string;
} {
  const todayYmd = utcDateToYmd(now);
  const yesterdayYmd = addCalendarDaysYmd(todayYmd, -1);
  return {
    fromIso: utcMidnightIso(yesterdayYmd),
    dateEndExclusiveIso: utcMidnightIso(todayYmd),
    fromDate: yesterdayYmd,
    toDate: yesterdayYmd,
  };
}

/** Inclusive `[fromYmd, toYmd]` in UTC calendar days → UTC bounds. */
export function utcInclusiveRangeToUtcBounds(
  fromYmd: string,
  toYmd: string
): {
  fromIso: string;
  dateEndExclusiveIso: string;
  fromDate: string;
  toDate: string;
} {
  const dayAfterTo = addCalendarDaysYmd(toYmd, 1);
  return {
    fromIso: utcMidnightIso(fromYmd),
    dateEndExclusiveIso: utcMidnightIso(dayAfterTo),
    fromDate: fromYmd,
    toDate: toYmd,
  };
}
