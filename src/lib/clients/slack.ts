// ============================================================================
// SLACK NOTIFICATION CLIENT
// ============================================================================
// Ported from spock-store src/component/integration/slack.ts
// Sends error, warning, info, and order notifications to Slack channels

import { config } from "../config";

type SlackChannel = keyof typeof config.slack.channel;

interface SlackAttachment {
  fallback: string;
  color: string;
  title: string;
  text: string;
  footer: string;
  footer_icon?: string;
  ts: number;
}

const APP_NAME = config.slack.applicationName;
const APP_ENV = config.slack.appEnv;

async function sendSlackMessage(
  channel: SlackChannel,
  attachments: SlackAttachment[]
): Promise<void> {
  const channelUrl = config.slack.channel[channel];

  if (!channelUrl) {
    console.log(`[Slack] [${channel}] No channel URL configured, logging: ${attachments[0]?.text}`);
    return;
  }

  if (config.features.dryRunMode) {
    console.log(`[Slack] [${channel}] DRY RUN - Would send: ${attachments[0]?.text}`);
    return;
  }

  try {
    const response = await fetch(channelUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attachments }),
    });

    if (!response.ok) {
      console.error(`[Slack] Failed to send message to ${channel}: ${response.status}`);
    }
  } catch (error) {
    console.error(`[Slack] Error sending message to ${channel}:`, error);
  }
}

export async function sendErrorMessage(
  channel: SlackChannel,
  message: string
): Promise<void> {
  await sendSlackMessage(channel, [
    {
      fallback: message,
      color: "danger",
      title: `:no_entry_sign: [${APP_ENV.toUpperCase()}] ${APP_NAME} error`,
      text: message,
      footer: APP_NAME,
      ts: Math.floor(Date.now() / 1000),
    },
  ]);
}

export async function sendWarningMessage(
  channel: SlackChannel,
  message: string
): Promise<void> {
  await sendSlackMessage(channel, [
    {
      fallback: message,
      color: "#ffcc00",
      title: `:warning: [${APP_ENV.toUpperCase()}] ${APP_NAME} warning`,
      text: message,
      footer: APP_NAME,
      ts: Math.floor(Date.now() / 1000),
    },
  ]);
}

export async function sendInfoMessage(
  channel: SlackChannel,
  message: string
): Promise<void> {
  await sendSlackMessage(channel, [
    {
      fallback: message,
      color: "#36a64f",
      title: `:white_check_mark: [${APP_ENV.toUpperCase()}] ${APP_NAME} info`,
      text: message,
      footer: APP_NAME,
      ts: Math.floor(Date.now() / 1000),
    },
  ]);
}

export async function sendOrderMessage(message: string): Promise<void> {
  await sendSlackMessage("order", [
    {
      fallback: message,
      color: "#36a64f",
      title: `:white_check_mark: Order Placement`,
      text: message,
      footer: APP_NAME,
      ts: Math.floor(Date.now() / 1000),
    },
  ]);
}

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
