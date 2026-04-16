import { inngest } from "../client";
import { THROTTLE_CONFIGS } from "@/lib/utils/constants";
import { refreshLocationMappings } from "@/lib/services/location-routing";
import { logFlowEvent } from "@/lib/services/supabase-flow-logs";

export const refreshLocationConfigCache = inngest.createFunction(
  {
    id: "refresh-location-config-cache",
    name: "Refresh Location Config Cache",
    concurrency: { limit: 1 },
    throttle: THROTTLE_CONFIGS.CRON,
    triggers: [{ cron: "0 * * * *" }],
  },
  async ({ step, event }: { step: any; event: any }) => {
    const _flowStart = Date.now();
    const _runId = (event as any).id;

    logFlowEvent({
      flow: "location_config_cache",
      step: "start",
      status: "started",
      runId: _runId,
      shopifyOrderId: event.data?.shopifyOrderId,
      shopifyOrderName: event.data?.shopifyOrderName,
      payload: { trigger: "hourly_cron" },
    });

    const result = await step.run("refresh-location-cache", async () => {
      return refreshLocationMappings("hourly_cron");
    });

    logFlowEvent({
      flow: "location_config_cache",
      step: "done",
      status: "completed",
      runId: _runId,
      durationMs: Date.now() - _flowStart,
      shopifyOrderId: event.data?.shopifyOrderId,
      shopifyOrderName: event.data?.shopifyOrderName,
      payload: { count: result.count, refreshed: result.refreshed },
    });

    return {
      status: "success",
      ...result,
    };
  }
);
