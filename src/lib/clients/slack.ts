import { randomUUID } from "node:crypto";
import { config } from "@/lib/config";
import { publishMessages } from "@/lib/clients/kafka";
import type { ISlackAttachment } from "../types/slack";
import { enqueueSlackNotification, drainSlackNotifications } from "@/lib/services/slack-notifications/outbox";
import { publishSlackToPubSub } from "./slack-pubsub";

// Type for Slack channel keys
type SlackChannel = keyof typeof config.slack.channel;

export type SlackSeverity = "info" | "success" | "warning" | "error" | "critical";

/**
 * Notification event consumed by slack-notification-service (formatter.BattleBus), which posts
 * each `id` to Slack at most once.
 */
export interface SlackNotification {
  /** Stable across Inngest retries and replays; build it with slackNotificationId. */
  id: string;
  channel: SlackChannel;
  severity: SlackSeverity;
  title: string;
  /** Slack mrkdwn styling is kept; links and mentions are escaped by the service. */
  summary?: string;
  fields?: Array<{ label: string; value: string }>;
  items?: string[];
  error?: { message: string; code?: string; detail?: string };
  links?: Array<{ label: string; url: string; style?: "primary" | "danger" }>;
  mention?: "here" | "channel";
  occurredAt?: string;
  environment?: string;
}

// slack-notification-service rejects longer summaries
const MAX_SUMMARY_LENGTH = 9000;

/**
 * Builds a notification id that is stable for one triggering event: Inngest retries and replays
 * of that event produce the same id, so the notification is posted once. Add parts when one event
 * can notify several times for the same purpose, e.g. once per order in a batch.
 */
export function slackNotificationId(
  scope: string | undefined | null,
  purpose: string,
  ...parts: Array<string | number | undefined | null>
): string {
  if (!scope) {
    // still deliverable, but no longer deduplicated across retries
    console.warn(`[Slack] notification "${purpose}" has no event scope; using a random id`);
  }
  return [
    scope || `unscoped-${randomUUID()}`,
    purpose,
    ...parts.filter((p) => p !== undefined && p !== null && p !== ""),
  ]
    .map(String)
    .join(":");
}

// ============================================================================
// TRANSPORTS
// ============================================================================

const slackSender = async (channel: SlackChannel, attachments: ISlackAttachment[]) => {
  const webhookUrl = config.slack.channel[channel];
  if (!webhookUrl) {
    return;
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ attachments }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Slack API error: ${response.status} - ${errorText}`);
  }

  return response;
};

// Legacy webhook format, kept unchanged while SLACK_TRANSPORT=webhook.
const WEBHOOK_STYLE: Record<SlackSeverity, { color: string; emoji: string; label: string }> = {
  info: { color: "#36a64f", emoji: ":white_check_mark:", label: "info" },
  success: { color: "#36a64f", emoji: ":white_check_mark:", label: "info" },
  warning: { color: "#ffcc00", emoji: ":warning:", label: "warning" },
  error: { color: "danger", emoji: ":no_entry_sign:", label: "error" },
  critical: { color: "danger", emoji: ":no_entry_sign:", label: "error" },
};

async function postToWebhook(notification: SlackNotification): Promise<void> {
  const style = WEBHOOK_STYLE[notification.severity];
  const msg = notification.summary ?? notification.title;
  const title =
    notification.title === ORDER_TITLE
      ? `:white_check_mark: Order Placement`
      : `${style.emoji} [${config.slack.appEnv.toLocaleUpperCase()}] ${config.slack.applicationName} ${style.label}`;

  await slackSender(notification.channel, [
    {
      fallback: msg,
      color: style.color,
      title,
      text: msg,
      footer: config.slack.applicationName,
      footer_icon: undefined,
      ts: Math.floor(Date.now() / 1000),
    },
  ]);
}

async function publishToKafka(notification: SlackNotification): Promise<void> {
  const prepared: SlackNotification = {
    ...notification,
    summary: notification.summary?.slice(0, MAX_SUMMARY_LENGTH),
  };
  await publishMessages(config.kafka.slackNotificationTopic, [
    {
      key: notification.channel,
      value: JSON.stringify(prepared),
      headers: { "notification-id": notification.id },
    },
  ]);
}

export async function drainSlackOutbox() {
  if (config.slack.transport === "webhook" || config.slack.integration !== "real" || !config.slack.publishEnabled) {
    return { claimed: 0, published: 0, failed: 0 };
  }
  return drainSlackNotifications(publishQueuedNotification);
}

async function publishQueuedNotification(notification: SlackNotification) {
  const prepared = { ...notification, summary: notification.summary?.slice(0, MAX_SUMMARY_LENGTH) };
  if (config.slack.transport === "pubsub") return publishSlackToPubSub(prepared);
  if (config.slack.transport === "kafka") return publishToKafka(prepared);
  throw new Error("Unsupported Slack outbox transport");
}

/**
 * Sends a notification through the configured transport. Never throws: a notification must not
 * fail the business flow, so failures are logged with the notification id instead.
 */
export async function sendSlackNotification(notification: SlackNotification): Promise<void> {
  try {
    if (config.slack.integration !== "real") {
      console.log(
        `[Slack] [${notification.severity}] [${notification.channel}] id=${notification.id} ${notification.summary ?? notification.title}`
      );
      return;
    }
    if (config.slack.transport === "kafka" || config.slack.transport === "pubsub") {
      await enqueueSlackNotification(notification);
      if (config.slack.publishEnabled) await drainSlackNotifications(publishQueuedNotification, notification.id);
    } else {
      await postToWebhook(notification);
    }
  } catch (e) {
    console.error(
      `[Slack] Unable to send ${notification.severity} notification channel=${notification.channel} id=${notification.id} transport=${config.slack.transport}:`,
      e
    );
  }
}

// ============================================================================
// MESSAGE HELPERS
// ============================================================================

const ORDER_TITLE = "Order placement";

const message =
  (severity: SlackSeverity, title: string) => (channel: SlackChannel, msg: string, id: string) =>
    sendSlackNotification({ id, channel, severity, title, summary: msg });

export const sendInfoMessage = message("info", "Battle Bus info");
export const sendWarningMessage = message("warning", "Battle Bus warning");
export const sendErrorMessage = message("error", "Battle Bus error");
export const sendOrderMessage = message("success", ORDER_TITLE);

export function determineErrorChannel(
  error: Error | string,
  context?: { locationId?: string; isStord?: boolean }
): SlackChannel {
  const errorMessage = typeof error === "string" ? error : error.message;

  if (context?.isStord) return "stord";

  if (errorMessage.includes("GPS")) {
    if (errorMessage.includes("库存不足") || errorMessage.includes("out of stock")) {
      return "gpslow";
    }
    return "gps";
  }

  if (errorMessage.includes("D365") || errorMessage.includes("Dynamics")) {
    return "dynamics";
  }

  return "shopify";
}
