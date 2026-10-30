import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  options: undefined as Record<string, unknown> | undefined,
  config: { enabled: true, sendEnabled: false },
}));

vi.mock("@/inngest/client", () => ({
  inngest: {
    createFunction: (options: Record<string, unknown>, handler: unknown) => {
      mocks.options = options;
      return handler;
    },
  },
}));
vi.mock("@/lib/config", () => ({ config: { channelLift: mocks.config } }));

import { scheduleMetaChannelLift } from "@/inngest/functions/schedule-meta-channel-lift";

describe("Meta channel-lift scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T04:35:00Z"));
    mocks.config.enabled = true;
    mocks.config.sendEnabled = false;
  });

  it("uses the local New York schedule and emits a stable dry-run request", async () => {
    expect(mocks.options?.triggers).toEqual([{ cron: "TZ=America/New_York 35 0 * * *" }]);
    const sendEvent = vi.fn().mockResolvedValue(undefined);
    await expect(
      (
        scheduleMetaChannelLift as unknown as (input: {
          step: { sendEvent: typeof sendEvent };
        }) => Promise<Record<string, unknown>>
      )({ step: { sendEvent } })
    ).resolves.toEqual({ status: "queued", reportingDate: "2026-07-14", mode: "dry_run" });
    expect(sendEvent).toHaveBeenCalledWith("request-channel-lift-run", {
      id: "channel-lift:scheduled:2026-07-14:dry_run",
      name: "meta.channel-lift/run.requested",
      data: {
        requestId: "scheduled:2026-07-14:dry_run",
        reportingDate: "2026-07-14",
        mode: "dry_run",
        source: "schedule",
      },
    });
  });
});
