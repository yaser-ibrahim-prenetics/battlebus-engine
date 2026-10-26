import { inngest } from "../client";
import { drainSlackOutbox } from "@/lib/clients/slack";

export const drainSlackNotificationOutbox = inngest.createFunction(
  {
    id: "drain-slack-notifications",
    name: "Drain Slack notification outbox",
    retries: 3,
    concurrency: { limit: 1 },
    triggers: [{ cron: "* * * * *" }],
  },
  async ({ step }) => step.run("publish-notifications", drainSlackOutbox)
);
