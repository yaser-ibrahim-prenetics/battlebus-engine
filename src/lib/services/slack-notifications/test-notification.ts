import { config } from "@/lib/config";
import { queryDatabase } from "@/lib/db/database";
import { publishSlackToPubSub } from "@/lib/clients/slack-pubsub";
import { notificationStatusSQL } from "@/lib/sql/slack-notifications/status";
import { drainSlackNotifications, enqueueSlackNotification } from "./outbox";

/** Use the production outbox and publisher without triggering any business workflow. */
export async function queueSlackTest(now = Date.now()) {
  if (
    config.slack.integration !== "real" ||
    config.slack.transport !== "pubsub" ||
    !config.slack.publishEnabled
  ) {
    return { enabled: false as const };
  }
  // Shared across users and instances: the database's unique key and consumer's
  // deduplication prevent repeated clicks from posting multiple tests per minute.
  const minute = Math.floor(now / 60_000);
  const notificationId = `hub-slack-test:${minute}`;
  await enqueueSlackNotification({
    id: notificationId,
    channel: "system",
    severity: "info",
    title: "Battle Hub Slack notification test",
    summary:
      "An administrator requested this synthetic test through Battle Hub → Battle Bus → Slack notification service. No customer data or business actions are involved.",
    fields: [{ label: "Test ID", value: notificationId }],
    occurredAt: new Date(minute * 60_000).toISOString(),
    environment: config.slack.appEnv,
  });
  await drainSlackNotifications(publishSlackToPubSub, notificationId);
  const { rows } = await queryDatabase<{ status: string }>(notificationStatusSQL, [notificationId]);
  const status = rows[0]?.status;
  if (!status || !["pending", "publishing", "published", "dead_letter"].includes(status)) {
    throw new Error("Slack test status unavailable");
  }
  return {
    enabled: true as const,
    notificationId,
    status: status === "published" ? "published" : status === "dead_letter" ? "failed" : "queued",
    nextTestAt: new Date((minute + 1) * 60_000).toISOString(),
  };
}
