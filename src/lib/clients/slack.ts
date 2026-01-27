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

export const sendWarningMessage =
  config.slack.integration === 'real'
    ? sendSlackWarningMessage
    : async (
        type: keyof typeof config.slack.channel,
        msg: string,
      ) => console.log(`[WARNING][${type}] ${msg}`);
