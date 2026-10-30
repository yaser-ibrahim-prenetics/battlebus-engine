import { describe, expect, it } from "vitest";

import {
  CHANNEL_LIFT_CRON,
  channelLiftDateRange,
  previousNewYorkReportingDate,
} from "@/lib/services/channel-lift/schedule";

describe("channel-lift scheduling", () => {
  it("uses a New York cron at 00:35", () => {
    expect(CHANNEL_LIFT_CRON).toBe("TZ=America/New_York 35 0 * * *");
  });

  it.each([
    ["winter", "2026-01-15T05:35:00Z", "2026-01-14"],
    ["summer", "2026-07-15T04:35:00Z", "2026-07-14"],
    ["spring DST boundary", "2026-03-09T04:35:00Z", "2026-03-08"],
    ["fall DST boundary", "2026-11-02T05:35:00Z", "2026-11-01"],
  ])("selects the previous reporting day in %s", (_label, now, expected) => {
    expect(previousNewYorkReportingDate(new Date(now))).toBe(expected);
  });

  it("builds an inclusive bounded backfill", () => {
    expect(
      channelLiftDateRange({
        startDate: "2026-10-01",
        endDate: "2026-10-03",
        now: new Date("2026-10-30T12:00:00Z"),
      })
    ).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
  });

  it("rejects future, mixed, reversed, and oversized ranges", () => {
    expect(() =>
      channelLiftDateRange({
        date: "2026-10-30",
        now: new Date("2026-10-30T12:00:00Z"),
      })
    ).toThrow("invalid_date_range");
    expect(() =>
      channelLiftDateRange({
        date: "2026-10-01",
        startDate: "2026-10-01",
        endDate: "2026-10-02",
      })
    ).toThrow("invalid_date_range");
    expect(() =>
      channelLiftDateRange({
        startDate: "2026-10-03",
        endDate: "2026-10-01",
      })
    ).toThrow("invalid_date_range");
    expect(() =>
      channelLiftDateRange({
        startDate: "2026-01-01",
        endDate: "2026-02-15",
        now: new Date("2026-10-30T12:00:00Z"),
      })
    ).toThrow("date_range_too_large");
  });
});
