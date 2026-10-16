import { describe, expect, it } from "vitest";
import {
  assertWebhookPayload,
  resolveWebhookSchemaVersion,
  WebhookSchemaError,
} from "@/lib/webhooks/schema-registry";

describe("webhook schema registry", () => {
  it("uses the current version when the sender omits a version", () => {
    expect(resolveWebhookSchemaVersion("shopify", {})).toBe("1.0");
  });

  it("reads schema version headers case-insensitively", () => {
    expect(
      resolveWebhookSchemaVersion("gps", { "X-Battle-Webhook-Schema-Version": "1.0" })
    ).toBe("1.0");
  });

  it("rejects unknown versions before they can enter the durable outbox", () => {
    expect(() =>
      resolveWebhookSchemaVersion("loop", { "x-webhook-schema-version": "2.0" })
    ).toThrow(WebhookSchemaError);
  });

  it("requires an object envelope", () => {
    expect(() => assertWebhookPayload([], "stord", "1.0")).toThrow(
      "requires an object payload"
    );
  });
});
