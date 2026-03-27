import { inngest } from "../client";
import { THROTTLE_CONFIGS } from "@/lib/utils/constants";
import { refreshLocationMappings } from "@/lib/services/location-routing";

export const refreshLocationConfigCache = inngest.createFunction(
  {
    id: "refresh-location-config-cache",
    name: "Refresh Location Config Cache",
    concurrency: { limit: 1 },
    throttle: THROTTLE_CONFIGS.CRON,
    triggers: [{ cron: "0 * * * *" }],
  },
  async ({ step }: { step: any }) => {
    const result = await step.run("refresh-location-cache", async () => {
      return refreshLocationMappings("hourly_cron");
    });

    return {
      status: "success",
      ...result,
    };
  }
);
