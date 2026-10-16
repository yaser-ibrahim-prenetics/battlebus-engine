import { describe, expect, it } from "vitest";
import { classifyDeliveryError } from "../delivery-error";
import { WebhookSchemaError } from "@/lib/webhooks/schema-registry";

describe("delivery error classification", () => {
  it("honors rate-limit retry guidance", () => {
    expect(classifyDeliveryError({ status: 429, retryAfter: 90 }, 2)).toMatchObject({
      errorClass: "rate_limited",
      recoveryAction: "retry_after",
      terminal: false,
      retryDelaySeconds: 90,
    });
  });

  it("retries transient dependency failures with bounded backoff", () => {
    expect(classifyDeliveryError({ statusCode: 503, message: "unavailable" }, 4)).toMatchObject({
      errorClass: "dependency_unavailable",
      recoveryAction: "retry",
      terminal: false,
      retryDelaySeconds: 240,
    });
  });

  it("sends invalid schemas directly to manual review", () => {
    expect(
      classifyDeliveryError(new WebhookSchemaError("unsupported", "shopify", "2.0"), 1)
    ).toMatchObject({
      errorClass: "validation",
      recoveryAction: "manual_review",
      terminal: true,
    });
  });

  it("dead-letters unknown failures after the retry budget", () => {
    expect(classifyDeliveryError(new Error("boom"), 10)).toMatchObject({
      errorClass: "unknown",
      recoveryAction: "manual_review",
      terminal: true,
    });
  });
});
