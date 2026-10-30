import { config } from "@/lib/config";
import type { MetaChannelLiftRunRequestedEvent } from "@/inngest/events";
import { inngest } from "@/inngest/client";
import {
  CHANNEL_LIFT_CRON,
  previousNewYorkReportingDate,
} from "@/lib/services/channel-lift/schedule";

type SchedulerStep = {
  sendEvent(id: string, event: { id: string } & MetaChannelLiftRunRequestedEvent): Promise<unknown>;
};

export const scheduleMetaChannelLift = inngest.createFunction(
  {
    id: "schedule-meta-channel-lift",
    name: "Schedule Meta Channel Lift",
    retries: 3,
    concurrency: { limit: 1 },
    triggers: [{ cron: CHANNEL_LIFT_CRON }],
  },
  async ({ step }: { step: SchedulerStep }) => {
    if (!config.channelLift.enabled) return { status: "disabled" };
    const reportingDate = previousNewYorkReportingDate();
    const mode = config.channelLift.sendEnabled ? "live" : "dry_run";
    const requestId = `scheduled:${reportingDate}:${mode}`;
    await step.sendEvent("request-channel-lift-run", {
      id: `channel-lift:${requestId}`,
      name: "meta.channel-lift/run.requested",
      data: { requestId, reportingDate, mode, source: "schedule" },
    });
    return { status: "queued", reportingDate, mode };
  }
);
