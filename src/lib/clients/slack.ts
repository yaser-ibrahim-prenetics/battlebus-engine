import { config } from "@/lib/config";
import { ISlackAttachment } from "../types/slack";

const slackSender = async (
  channel: keyof typeof config.slack.channel,
  attachments: ISlackAttachment[],
) => {
  const webhookUrl = config.slack.channel[channel];
  if (!webhookUrl) throw new Error(`Slack webhook URL not configured for channel: ${channel}`);

  const response = await fetch(webhookUrl, {
    method: 'POST',
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

const sendSlackInfoMessage = async (
  type: keyof typeof config.slack.channel,
  msg: string,
) => {
  try {
    await slackSender(type, [
      {
        fallback: msg,
        color: '#36a64f',
        title: `:white_check_mark: [${config.slack.appEnv.toLocaleUpperCase()}] ${config.slack.applicationName} info`,
        text: msg,
        footer: config.slack.applicationName,
        footer_icon: undefined,
        ts: Math.floor(Date.now() / 1000),
      },
    ]);
  } catch (e) {
    console.error(`Unable to send Slack info message to ${type}:`, e);
  }
};

const sendSlackWarningMessage = async (
  type: keyof typeof config.slack.channel,
  msg: string,
) => {
  try {
    await slackSender(type, [
      {
        fallback: msg,
        color: '#ffcc00',
        title: `:warning: [${config.slack.appEnv.toLocaleUpperCase()}] ${config.slack.applicationName} warning`,
        text: msg,
        footer: config.slack.applicationName,
        footer_icon: undefined,
        ts: Math.floor(Date.now() / 1000),
      },
    ]);
  } catch (e) {
    console.error(`Unable to send Slack warning message to ${type}:`, e);
  }
};

const sendSlackErrorMessage = async (
  type: keyof typeof config.slack.channel,
  msg: string,
) => {
  try {
    await slackSender(type, [
      {
        fallback: msg,
        color: 'danger',
        title: `:no_entry_sign: [${config.slack.appEnv.toLocaleUpperCase()}] ${config.slack.applicationName} error`,
        text: msg,
        footer: config.slack.applicationName,
        footer_icon: undefined,
        ts: Math.floor(Date.now() / 1000),
      },
    ]);
  } catch (e) {
    console.error(`Unable to send Slack error message to ${type}:`, e);
  }
};

const sendSlackOrderMessage = async (
  type: keyof typeof config.slack.channel,
  msg: string,
) => {
  try {
    await slackSender(type, [
      {
        fallback: msg,
        color: '#36a64f',
        title: `:white_check_mark: Order Placement`,
        text: msg,
        footer: config.slack.applicationName,
        footer_icon: undefined,
        ts: Math.floor(Date.now() / 1000),
      },
    ]);
  } catch (e) {
    console.error(`Unable to send Slack order message to ${type}:`, e);
  }
};

export const sendInfoMessage =
  config.slack.integration === 'real'
    ? sendSlackInfoMessage
    : async (
        type: keyof typeof config.slack.channel,
        msg: string,
      ) => console.log(`[INFO][${type}] ${msg}`);

export const sendWarningMessage =
  config.slack.integration === 'real'
    ? sendSlackWarningMessage
    : async (
        type: keyof typeof config.slack.channel,
        msg: string,
      ) => console.log(`[WARNING][${type}] ${msg}`);

export const sendErrorMessage =
  config.slack.integration === 'real'
    ? sendSlackErrorMessage
    : async (
        type: keyof typeof config.slack.channel,
        msg: string,
      ) => console.log(`[ERROR][${type}] ${msg}`);

export const sendOrderMessage =
  config.slack.integration === 'real'
    ? sendSlackOrderMessage
    : async (
        type: keyof typeof config.slack.channel,
        msg: string,
      ) => console.log(`[ORDER][${type}] ${msg}`);

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
