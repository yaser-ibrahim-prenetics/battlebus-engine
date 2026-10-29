/** Manual service-path probe. Requires the same database and transport config as Battle Bus. */
import { config as loadEnv } from "dotenv";
import { randomUUID } from "node:crypto";
loadEnv({ path: ".env.local" });

async function main() {
  const { config, validateConfig } = await import("../src/lib/config");
  const { enqueueSlackNotification } =
    await import("../src/lib/services/slack-notifications/outbox");
  const { drainSlackOutbox } = await import("../src/lib/clients/slack");
  console.log(
    `Slack service transport: ${config.slack.transport}; publishing: ${config.slack.publishEnabled}`
  );
  if (process.env.SLACK_TEST_SEND !== "true") {
    console.log("Dry run. Set SLACK_TEST_SEND=true to enqueue a system notification.");
    return;
  }
  const errors = validateConfig().errors.filter((error) => /SLACK_|KAFKA_/.test(error));
  if (errors.length) throw new Error(errors.join("; "));
  if (!config.slack.publishEnabled) throw new Error("Slack publication is paused");
  const id = `manual-test:${randomUUID()}`;
  await enqueueSlackNotification({
    id,
    channel: "system",
    severity: "info",
    title: "Battle Bus notification test",
    summary: "Manual notification-service integration test.",
  });
  const result = await drainSlackOutbox();
  console.log(
    JSON.stringify({
      id,
      result,
      note: "Queued durably; transport publication is not confirmed Slack delivery. Check the service using this ID.",
    })
  );
}
main()
  .then(() => process.exit(0))
  .catch(() => {
    console.error("Slack service probe failed; check configuration and outbox status.");
    process.exit(1);
  });
