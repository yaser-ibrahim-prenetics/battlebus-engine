import { GoogleAuth } from "google-auth-library";
import { config } from "@/lib/config";
import type { SlackNotification } from "./slack";

const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/pubsub"] });

export async function publishSlackToPubSub(notification: SlackNotification): Promise<void> {
  const topic = config.slack.pubsubTopic;
  if (!/^projects\/[a-z][a-z0-9-]+\/topics\/[a-zA-Z][a-zA-Z0-9._~+%-]+$/.test(topic)) {
    throw new Error("SLACK_PUBSUB_TOPIC must be a full Pub/Sub topic resource");
  }
  const client = await auth.getClient();
  const result = await client.request<{ messageIds: string[] }>({
    url: `https://pubsub.googleapis.com/v1/${topic}:publish`,
    method: "POST",
    timeout: 10_000,
    retry: false, // The durable outbox owns publication retries.
    data: { messages: [{
      data: Buffer.from(JSON.stringify(notification)).toString("base64"),
      attributes: { "notification-id": notification.id, "schema-version": "1" },
    }] },
  });
  if (result.data.messageIds?.length !== 1) throw new Error("Pub/Sub did not acknowledge the notification");
}
