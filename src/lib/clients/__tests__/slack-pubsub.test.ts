import { afterEach, describe, expect, it, vi } from "vitest";
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    async getClient() {
      return { request };
    }
  },
}));
describe("Slack Pub/Sub publication", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    request.mockReset();
  });
  it("publishes the versioned payload using Google service credentials", async () => {
    vi.stubEnv("SLACK_PUBSUB_TOPIC", "projects/test-project/topics/bus-alerts");
    const { publishSlackToPubSub } = await import("../slack-pubsub");
    request.mockResolvedValue({ data: { messageIds: ["1"] } });
    const event = {
      id: "evt:1",
      channel: "system" as const,
      severity: "info" as const,
      title: "test",
    };
    await publishSlackToPubSub(event);
    const args = request.mock.calls[0][0];
    expect(args.url).toBe(
      "https://pubsub.googleapis.com/v1/projects/test-project/topics/bus-alerts:publish"
    );
    expect(JSON.parse(Buffer.from(args.data.messages[0].data, "base64").toString())).toEqual(event);
    expect(args.data.messages[0].attributes).toEqual({
      "notification-id": "evt:1",
      "schema-version": "1",
    });
    request.mockResolvedValue({ data: {} });
    await expect(publishSlackToPubSub(event)).rejects.toThrow("did not acknowledge");
  });
});
