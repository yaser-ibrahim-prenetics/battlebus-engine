import { config } from "@/lib/config";
import { ISlackAttachment } from "../types/slack";

// Type for Slack channel keys
type SlackChannel = keyof typeof config.slack.channel;

const slackSender = async (
  channel: keyof typeof config.slack.channel,
  attachments: ISlackAttachment[]
) => {
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

const sendSlackInfoMessage = async (type: keyof typeof config.slack.channel, msg: string) => {
  try {
    await slackSender(type, [
      {
        fallback: msg,
        color: "#36a64f",
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

const sendSlackWarningMessage = async (type: keyof typeof config.slack.channel, msg: string) => {
  try {
    await slackSender(type, [
      {
        fallback: msg,
        color: "#ffcc00",
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

const sendSlackErrorMessage = async (type: keyof typeof config.slack.channel, msg: string) => {
  try {
    await slackSender(type, [
      {
        fallback: msg,
        color: "danger",
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

const sendSlackOrderMessage = async (type: keyof typeof config.slack.channel, msg: string) => {
  try {
    await slackSender(type, [
      {
        fallback: msg,
        color: "#36a64f",
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
  config.slack.integration === "real"
    ? sendSlackInfoMessage
    : async (type: keyof typeof config.slack.channel, msg: string) =>
        console.log(`[INFO][${type}] ${msg}`);

export const sendWarningMessage =
  config.slack.integration === "real"
    ? sendSlackWarningMessage
    : async (type: keyof typeof config.slack.channel, msg: string) =>
        console.log(`[WARNING][${type}] ${msg}`);

export const sendErrorMessage =
  config.slack.integration === "real"
    ? sendSlackErrorMessage
    : async (type: keyof typeof config.slack.channel, msg: string) =>
        console.log(`[ERROR][${type}] ${msg}`);

export const sendOrderMessage =
  config.slack.integration === "real"
    ? sendSlackOrderMessage
    : async (type: keyof typeof config.slack.channel, msg: string) =>
        console.log(`[ORDER][${type}] ${msg}`);

// ============================================================================
// BATCH NOTIFICATION AGGREGATOR
// ============================================================================
// During high-volume bursts (e.g., 1,375 Skio orders), instead of sending
// 1,375 individual Slack messages, aggregate into periodic summaries.

interface BatchBuffer {
  messages: string[];
  channel: keyof typeof config.slack.channel;
  startedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const _batchWindowParsed = parseInt(process.env.SLACK_BATCH_WINDOW_MS || "10000", 10);
const BATCH_WINDOW_MS = Number.isNaN(_batchWindowParsed) ? 10000 : _batchWindowParsed; // 10 seconds
const _batchMaxSizeParsed = parseInt(process.env.SLACK_BATCH_MAX_SIZE || "50", 10);
const BATCH_MAX_SIZE = Number.isNaN(_batchMaxSizeParsed) ? 50 : _batchMaxSizeParsed;
const batchBuffers: Map<string, BatchBuffer> = new Map();

/**
 * Flush a batch buffer, sending an aggregated summary message to Slack.
 */
async function flushBatch(channelKey: string): Promise<void> {
  const buffer = batchBuffers.get(channelKey);
  if (!buffer || buffer.messages.length === 0) {
    batchBuffers.delete(channelKey);
    return;
  }

  if (buffer.timer) {
    clearTimeout(buffer.timer);
    buffer.timer = null;
  }

  const messages = [...buffer.messages];
  const channel = buffer.channel;
  batchBuffers.delete(channelKey);

  const total = messages.length;
  const preview = messages.slice(0, 5).map((m) => `• ${m}`).join('\n');
  const suffix = total > 5 ? `\n…and ${total - 5} more` : '';
  const summary = `📊 Batch Summary (${total} messages):\n${preview}${suffix}`;

  await sendInfoMessage(channel, summary);
}

/**
 * Send a message that may be batched during high-volume periods.
 * Messages to the same channel within BATCH_WINDOW_MS are aggregated.
 * Use this for info/success notifications. Error messages should NOT be batched.
 */
export async function sendBatchableInfoMessage(
  channel: keyof typeof config.slack.channel,
  msg: string
): Promise<void> {
  const key = `info:${channel}`;
  let buffer = batchBuffers.get(key);

  if (!buffer) {
    buffer = {
      messages: [],
      channel,
      startedAt: Date.now(),
      timer: null,
    };
    batchBuffers.set(key, buffer);
  }

  buffer.messages.push(msg);

  // Flush immediately if we hit the max batch size
  if (buffer.messages.length >= BATCH_MAX_SIZE) {
    await flushBatch(key);
    return;
  }

  // Reset the window timer on each new message
  if (buffer.timer) {
    clearTimeout(buffer.timer);
  }
  buffer.timer = setTimeout(() => {
    flushBatch(key).catch((err) =>
      console.error(`[Slack] Failed to flush batch for ${key}:`, err)
    );
  }, BATCH_WINDOW_MS);
}

/**
 * Send an order placement message that may be batched during high-volume periods.
 * Uses the order message style. Error messages should NOT be batched.
 */
export async function sendBatchableOrderMessage(
  channel: keyof typeof config.slack.channel,
  msg: string
): Promise<void> {
  const key = `order:${channel}`;
  let buffer = batchBuffers.get(key);

  if (!buffer) {
    buffer = {
      messages: [],
      channel,
      startedAt: Date.now(),
      timer: null,
    };
    batchBuffers.set(key, buffer);
  }

  buffer.messages.push(msg);

  // Flush immediately if we hit the max batch size
  if (buffer.messages.length >= BATCH_MAX_SIZE) {
    const messages = [...buffer.messages];
    if (buffer.timer) {
      clearTimeout(buffer.timer);
      buffer.timer = null;
    }
    batchBuffers.delete(key);

    const total = messages.length;
    const preview = messages.slice(0, 5).map((m) => `• ${m}`).join('\n');
    const suffix = total > 5 ? `\n…and ${total - 5} more` : '';
    const summary = `📊 Order Batch Summary (${total} orders processed):\n${preview}${suffix}`;

    await sendOrderMessage(channel, summary);
    return;
  }

  // Reset the window timer on each new message
  if (buffer.timer) {
    clearTimeout(buffer.timer);
  }
  buffer.timer = setTimeout(async () => {
    const buf = batchBuffers.get(key);
    if (!buf || buf.messages.length === 0) {
      batchBuffers.delete(key);
      return;
    }

    const messages = [...buf.messages];
    if (buf.timer) {
      clearTimeout(buf.timer);
      buf.timer = null;
    }
    batchBuffers.delete(key);

    const total = messages.length;
    const preview = messages.slice(0, 5).map((m) => `• ${m}`).join('\n');
    const suffix = total > 5 ? `\n…and ${total - 5} more` : '';
    const summary = `📊 Order Batch Summary (${total} orders processed):\n${preview}${suffix}`;

    await sendOrderMessage(channel, summary).catch((err) =>
      console.error(`[Slack] Failed to flush order batch for ${key}:`, err)
    );
  }, BATCH_WINDOW_MS);
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
