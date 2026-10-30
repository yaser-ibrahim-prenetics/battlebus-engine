import { describe, expect, it } from "vitest";
import { recoveryCommandSchema } from "@/lib/services/operations/commands";
import { openAiAdsReplayRequestSchema } from "@/lib/services/operations/openai-ads-replay";
import { waitingDeadline } from "@/lib/services/operations/workflow-waits";
const request = {
  requestId: "00000000-0000-4000-8000-000000000001",
  actorId: "admin",
  actorEmail: "admin@example.com",
  reason: "Investigated provider failure",
  parameters: { operation: "resume_order", orderId: "123" },
};
describe("restricted recovery commands", () => {
  it("rejects arbitrary events, provider payloads, invalid identities and missing reasons", () => {
    expect(recoveryCommandSchema.safeParse(request).success).toBe(true);
    for (const input of [
      { ...request, reason: "" },
      { ...request, parameters: { ...request.parameters, force: true } },
      { ...request, parameters: { operation: "execute", event: "anything" } },
      { ...request, parameters: { ...request.parameters, orderId: "1 or 1=1" } },
    ])
      expect(recoveryCommandSchema.safeParse(input).success).toBe(false);
  });
  it("distinguishes deliberate 24-hour waits from unknown wait formats", () => {
    expect(waitingDeadline("sleep", ["24h"], 0)).toEqual({ until: "1970-01-02T00:00:00.000Z" });
    expect(waitingDeadline("sleepUntil", ["2026-10-29T12:00:00Z"])).toEqual({
      until: "2026-10-29T12:00:00.000Z",
    });
    expect(waitingDeadline("waitForEvent", [{ timeout: "7 days" }], 0)).toEqual({
      until: "1970-01-08T00:00:00.000Z",
    });
    expect(waitingDeadline("sleep", ["unknown"], 0)).toEqual({ until: null });
    expect(waitingDeadline("run", [], 0)).toBeNull();
  });
  it("accepts only bounded OpenAI Ads replay identities", () => {
    const replay = {
      ...request,
      parameters: {
        operation: "replay_openai_ads",
        eventId: "bb_order_created_0000000000000000000000000000000000000000",
      },
    };
    expect(openAiAdsReplayRequestSchema.safeParse(replay).success).toBe(true);
    expect(
      openAiAdsReplayRequestSchema.safeParse({
        ...replay,
        parameters: { ...replay.parameters, eventId: "shopify-order-123" },
      }).success
    ).toBe(false);
    expect(
      openAiAdsReplayRequestSchema.safeParse({
        ...replay,
        parameters: { ...replay.parameters, force: true },
      }).success
    ).toBe(false);
  });
});
