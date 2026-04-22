/**
 * Slack error notification test helper.
 *
 * Usage:
 *   npx tsx scripts/test-slack-error-notifications.ts
 *
 * Optional env vars:
 *   SLACK_TEST_SEND=true            # actually send message (default: false)
 *   SLACK_TEST_CHANNEL=shopify      # one of: order,general,europa,system,shopify,shopifylow,prive,loop,dynamics,circledna,circlednaorder,gps,gpslow,stord
 *   SLACK_TEST_MESSAGE="Custom msg" # custom message body
 */

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

type ChannelKey =
  | "order"
  | "general"
  | "europa"
  | "system"
  | "shopify"
  | "shopifylow"
  | "prive"
  | "loop"
  | "dynamics"
  | "circledna"
  | "circlednaorder"
  | "gps"
  | "gpslow"
  | "stord";

const channelEnvMap: Record<ChannelKey, string> = {
  order: "SLACK_ORDER_CHANNEL",
  general: "SLACK_GENERAL_CHANNEL",
  europa: "SLACK_EUROPA_CHANNEL",
  system: "SLACK_SYSTEM_CHANNEL",
  shopify: "SLACK_SHOPIFY_CHANNEL",
  shopifylow: "SLACK_SHOPIFY_FLOW_CHANNEL",
  prive: "SLACK_PRIVE_CHANNEL",
  loop: "SLACK_LOOP_CHANNEL",
  dynamics: "SLACK_DYNAMICS_CHANNEL",
  circledna: "SLACK_CIRCLEDNA_CHANNEL",
  circlednaorder: "SLACK_CIRCLE_DNA_ORDER_CHANNEL",
  gps: "SLACK_GPS_CHANNEL",
  gpslow: "SLACK_GPS_LOW_CHANNEL",
  stord: "SLACK_STORD_CHANNEL",
};

const allChannels = Object.keys(channelEnvMap) as ChannelKey[];
const configuredChannels = allChannels.filter((ch) => {
  const envKey = channelEnvMap[ch];
  return Boolean((process.env[envKey] || "").trim());
});

const shouldSend = String(process.env.SLACK_TEST_SEND || "false").toLowerCase() === "true";
const targetChannel = (process.env.SLACK_TEST_CHANNEL || "shopify").trim() as ChannelKey;
const message =
  process.env.SLACK_TEST_MESSAGE ||
  `Slack error test from battle-bus (${new Date().toISOString()})`;

function printSummary() {
  console.log("=== Slack notification test summary ===");
  console.log(`Configured channels: ${configuredChannels.length}/${allChannels.length}`);
  for (const ch of allChannels) {
    const envKey = channelEnvMap[ch];
    const isSet = Boolean((process.env[envKey] || "").trim());
    console.log(`- ${ch}: ${isSet ? "configured" : "missing"} (${envKey})`);
  }
  console.log(`Mode: ${shouldSend ? "send" : "dry-run"}`);
  console.log(`Target channel: ${targetChannel}`);
}

async function sendSlackTest(channel: ChannelKey) {
  const envKey = channelEnvMap[channel];
  const webhookUrl = (process.env[envKey] || "").trim();
  if (!webhookUrl) {
    throw new Error(`Missing webhook URL for channel "${channel}" (${envKey})`);
  }

  const payload = {
    attachments: [
      {
        fallback: message,
        color: "danger",
        title: ":no_entry_sign: [TEST] Battle Bus error notification check",
        text: message,
        ts: Math.floor(Date.now() / 1000),
      },
    ],
  };

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const body = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`Slack returned ${res.status}: ${body.slice(0, 500)}`);
  }
}

(async () => {
  printSummary();

  if (!shouldSend) {
    console.log("Dry-run only. Set SLACK_TEST_SEND=true to send a real test notification.");
    process.exit(0);
  }

  if (!allChannels.includes(targetChannel)) {
    console.error(`Invalid SLACK_TEST_CHANNEL="${targetChannel}"`);
    process.exit(1);
  }

  try {
    await sendSlackTest(targetChannel);
    console.log(`✅ Sent test error notification to "${targetChannel}"`);
  } catch (error) {
    console.error("❌ Slack test failed:", error);
    process.exit(1);
  }
})();
