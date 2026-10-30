import { ChannelLiftError, validateReportingDate } from "@/lib/channel-lift/model";

export const CHANNEL_LIFT_TIME_ZONE = "America/New_York";
export const CHANNEL_LIFT_CRON = `TZ=${CHANNEL_LIFT_TIME_ZONE} 35 0 * * *`;

function zonedDateParts(date: Date): { year: string; month: string; day: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CHANNEL_LIFT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return { year: value("year"), month: value("month"), day: value("day") };
}

export function currentNewYorkDate(now = new Date()): string {
  const { year, month, day } = zonedDateParts(now);
  return validateReportingDate(`${year}-${month}-${day}`);
}

export function previousNewYorkReportingDate(now = new Date()): string {
  const current = currentNewYorkDate(now);
  const date = new Date(`${current}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export function channelLiftDateRange({
  date,
  startDate,
  endDate,
  now = new Date(),
  maxDays = 31,
}: {
  date?: string;
  startDate?: string;
  endDate?: string;
  now?: Date;
  maxDays?: number;
}): string[] {
  if (date && (startDate || endDate)) throw new ChannelLiftError("invalid_date_range");
  if (!date && (!startDate || !endDate)) throw new ChannelLiftError("invalid_date_range");
  const first = validateReportingDate(date ?? startDate);
  const last = validateReportingDate(date ?? endDate);
  if (first > last || last >= currentNewYorkDate(now)) {
    throw new ChannelLiftError("invalid_date_range");
  }
  const dates: string[] = [];
  for (
    let cursor = new Date(`${first}T00:00:00.000Z`);
    cursor.toISOString().slice(0, 10) <= last;
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  ) {
    dates.push(cursor.toISOString().slice(0, 10));
    if (dates.length > maxDays) throw new ChannelLiftError("date_range_too_large");
  }
  return dates;
}
