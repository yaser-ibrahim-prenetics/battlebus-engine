import crypto from "crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const envSnapshot = { ...process.env };

afterEach(() => {
  vi.resetModules();
  process.env = { ...envSnapshot };
});

describe("GPS webhook signatures", () => {
  it("fails closed when GPS_API_SECRET is not configured", async () => {
    delete process.env.GPS_API_SECRET;
    const { verifyWebhookSignature } = await import("../gps");

    expect(verifyWebhookSignature("{}", "anything", "1234")).toBe(false);
  });

  it("accepts a valid timestamped HMAC", async () => {
    process.env.GPS_API_SECRET = "gps-test-secret";
    const body = JSON.stringify({ orderId: "GPS-1" });
    const timestamp = "1790238752";
    const signature = crypto
      .createHmac("sha256", process.env.GPS_API_SECRET)
      .update(`${timestamp}${body}`)
      .digest("hex");
    const { verifyWebhookSignature } = await import("../gps");

    expect(verifyWebhookSignature(body, signature, timestamp)).toBe(true);
  });
});
