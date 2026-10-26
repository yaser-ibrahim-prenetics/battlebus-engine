import { afterEach, describe, expect, it, vi } from "vitest";

const publishMessages = vi.fn();
vi.mock("@/lib/clients/kafka", () => ({ publishMessages }));

describe("Slack notifications", () => {
  const previous = { ...process.env };
  afterEach(() => {
    process.env = { ...previous };
    publishMessages.mockReset();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function load(env: Record<string, string>) {
    Object.assign(process.env, env);
    vi.resetModules();
    return import("../slack");
  }

  it("builds ids that are stable for one event and distinct per purpose and part", async () => {
    const { slackNotificationId } = await load({});
    expect(slackNotificationId("01JB-event", "backorder-resolved", 2)).toBe("01JB-event:backorder-resolved:2");
    expect(slackNotificationId("01JB-event", "backorder-resolved", 2)).toBe(
      slackNotificationId("01JB-event", "backorder-resolved", 2)
    );
    expect(slackNotificationId("01JB-event", "gps-sync-summary", undefined, "")).toBe("01JB-event:gps-sync-summary");
    expect(slackNotificationId(undefined, "x")).toMatch(/^unscoped-[0-9a-f-]+:x$/);
  });

  it("publishes the structured event to Kafka when SLACK_TRANSPORT=kafka", async () => {
    const slack = await load({ SLACK_TRANSPORT: "kafka", KAFKA_BOOTSTRAP_SERVERS: "localhost:9092" });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await slack.sendErrorMessage("gps", "GPS order failed for #1001", "evt-1:order-gps-dispatch-failed");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(publishMessages).toHaveBeenCalledTimes(1);
    const [topic, messages] = publishMessages.mock.calls[0];
    expect(topic).toBe("battle-bus.slack-notification");
    expect(messages[0].key).toBe("gps");
    expect(messages[0].headers).toEqual({ "notification-id": "evt-1:order-gps-dispatch-failed" });
    expect(JSON.parse(messages[0].value)).toEqual({
      id: "evt-1:order-gps-dispatch-failed",
      channel: "gps",
      severity: "error",
      title: "Battle Bus error",
      summary: "GPS order failed for #1001",
    });
  });

  it("truncates summaries the notification service would reject", async () => {
    const slack = await load({ SLACK_TRANSPORT: "kafka", KAFKA_BOOTSTRAP_SERVERS: "localhost:9092" });
    await slack.sendWarningMessage("dynamics", "x".repeat(20_000), "evt-2:long");
    const event = JSON.parse(publishMessages.mock.calls[0][1][0].value);
    expect(event.summary).toHaveLength(9000);
  });

  it("preserves long reconciliation summaries in webhook notifications", async () => {
    const slack = await load({ SLACK_TRANSPORT: "webhook", SLACK_GPS_CHANNEL: "https://hooks.slack.test/gps" });
    const fetchSpy = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const summary = "Unsynced orders:\n" + "#123456789\n".repeat(1000) + "#LAST-ORDER";

    await slack.sendErrorMessage("gps", summary, "evt-5:reconciliation-result");

    expect(publishMessages).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const calls = fetchSpy.mock.calls as unknown as Array<[string, RequestInit]>;
    const attachment = JSON.parse(String(calls[0][1].body)).attachments[0];
    expect(attachment.text).toBe(summary);
    expect(attachment.fallback).toBe(summary);
  });

  it("never throws when publishing fails", async () => {
    const slack = await load({ SLACK_TRANSPORT: "kafka", KAFKA_BOOTSTRAP_SERVERS: "localhost:9092" });
    publishMessages.mockRejectedValueOnce(new Error("broker unavailable"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(slack.sendInfoMessage("order", "hello", "evt-3:x")).resolves.toBeUndefined();
    expect(errorLog.mock.calls[0][0]).toContain("id=evt-3:x");
    errorLog.mockRestore();
  });

  it("keeps posting the legacy webhook format by default", async () => {
    const slack = await load({ SLACK_GPS_CHANNEL: "https://hooks.slack.test/gps" });
    const fetchSpy = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await slack.sendWarningMessage("gps", "Inventory low", "evt-4:x");
    await slack.sendOrderMessage("gps", "Order placed", "evt-4:y");

    expect(publishMessages).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const calls = fetchSpy.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0][0]).toBe("https://hooks.slack.test/gps");
    const warning = JSON.parse(String(calls[0][1].body)).attachments[0];
    expect(warning).toMatchObject({ color: "#ffcc00", title: ":warning: [LOCAL] store warning", text: "Inventory low" });
    const order = JSON.parse(String(calls[1][1].body)).attachments[0];
    expect(order).toMatchObject({ color: "#36a64f", title: ":white_check_mark: Order Placement", text: "Order placed" });
  });

  it("requires Kafka brokers when SLACK_TRANSPORT=kafka", async () => {
    Object.assign(process.env, { SLACK_TRANSPORT: "kafka", KAFKA_BOOTSTRAP_SERVERS: "" });
    vi.resetModules();
    const { validateConfig } = await import("@/lib/config");
    expect(validateConfig().errors).toContain("KAFKA_BOOTSTRAP_SERVERS is required when SLACK_TRANSPORT=kafka");
  });
});
