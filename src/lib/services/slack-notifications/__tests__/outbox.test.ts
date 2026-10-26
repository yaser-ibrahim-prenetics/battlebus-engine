import { beforeEach, describe, expect, it, vi } from "vitest";
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/db/database", () => ({ queryDatabase: query }));
import { enqueueSlackNotification, drainSlackNotifications } from "../outbox";
import type { SlackNotification } from "@/lib/clients/slack";

const payload: SlackNotification = {
  id: "evt:error",
  channel: "system",
  severity: "error",
  title: "Failure",
};
const row = { notification_id: payload.id, payload, lease_token: "lease-1", attempts: 1 };

describe("Slack durable publication", () => {
  beforeEach(() => query.mockReset());

  it("awaits persistence before a notification is accepted", async () => {
    query.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(enqueueSlackNotification(payload)).rejects.toThrow("database unavailable");
  });

  it("keeps the original notification ID when a transport fails and is retried", async () => {
    query.mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [] });
    const publish = vi.fn().mockRejectedValueOnce(new Error("secret-containing provider failure"));
    expect(await drainSlackNotifications(publish)).toEqual({ claimed: 1, published: 0, failed: 1 });
    expect(publish).toHaveBeenCalledWith(payload);
    expect(query.mock.calls[1][1]).toEqual([payload.id, "lease-1"]);
    expect(JSON.stringify(query.mock.calls)).not.toContain("secret-containing");
    query.mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [] });
    publish.mockResolvedValueOnce(undefined);
    expect(await drainSlackNotifications(publish)).toEqual({ claimed: 1, published: 1, failed: 0 });
    expect(publish).toHaveBeenLastCalledWith(payload);
  });

  it("retains an uncertain publish for safe retry if the database update fails", async () => {
    query
      .mockResolvedValueOnce({ rows: [row] })
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValueOnce({ rows: [] });
    const publish = vi.fn().mockResolvedValue(undefined);
    expect((await drainSlackNotifications(publish)).failed).toBe(1);
    expect(query.mock.calls[2][1]).toEqual([payload.id, "lease-1"]);
  });
});
