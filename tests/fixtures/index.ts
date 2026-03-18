import type { ShopifyOrderPayload } from "@/inngest/events";
import { readFileSync } from "fs";
import { join } from "path";

const fixtureDir = join(__dirname, "shopify-orders");

function loadJson(filename: string): ShopifyOrderPayload {
  const raw = readFileSync(join(fixtureDir, filename), "utf-8");
  return JSON.parse(raw) as ShopifyOrderPayload;
}

export const fixtureFiles = {
  gpsUsOrder: "gps-us-order.json",
  gpsUkOrder: "gps-uk-order.json",
  hkOrder: "hk-order.json",
  stordOrder: "stord-order.json",
  gstFeeOrder: "gst-fee-order.json",
  subscriptionOrder: "subscription-order.json",
  multiLineOrder: "multi-line-order.json",
} as const;

export type FixtureName = keyof typeof fixtureFiles;

export function loadFixture(name: FixtureName): ShopifyOrderPayload {
  return loadJson(fixtureFiles[name]);
}

export function loadAllFixtures(): Record<FixtureName, ShopifyOrderPayload> {
  const result = {} as Record<FixtureName, ShopifyOrderPayload>;
  for (const [key, filename] of Object.entries(fixtureFiles)) {
    result[key as FixtureName] = loadJson(filename);
  }
  return result;
}
