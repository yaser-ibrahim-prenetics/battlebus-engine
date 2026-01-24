import { config } from "@/lib/config";

const slackSender = async (
  channel: keyof typeof config.slack.channel,
  attachments: any[],
) => {
  await fetch(config.slack.channel[channel], {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      attachments,
    }),
  });
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
        ts: (new Date().getTime() / 1000) | 0,
      },
    ]);
  } catch (e) {
    console.error(`Unable to send message. Unexpected warning logging message: ${e}`);
  }
};

export const sendWarningMessage =
  config.slack.integration === 'real'
    ? sendSlackWarningMessage
    : async (
        type: Exclude<keyof typeof config.slack.channel, symbol>,
        msg: string,
      ) => console.log(`[${type}], ${msg}`);
