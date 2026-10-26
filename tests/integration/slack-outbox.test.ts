import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/db/database", () => ({ queryDatabase: query }));
import {
  enqueueSlackNotification,
  drainSlackNotifications,
} from "@/lib/services/slack-notifications/outbox";
import type { SlackNotification } from "@/lib/clients/slack";

describe.skipIf(!process.env.SLACK_TEST_DATABASE_URL)("Slack outbox PostgreSQL contract", () => {
  let pool: Pool;
  const notification: SlackNotification = {
    id: "test:slack-outbox",
    channel: "system",
    severity: "info",
    title: "Synthetic",
  };
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.SLACK_TEST_DATABASE_URL });
    query.mockImplementation((sql, values) => pool.query(sql, values));
    await pool.query("DELETE FROM public.slack_notification_outbox WHERE notification_id=$1", [
      notification.id,
    ]);
  });
  afterAll(async () => {
    await pool?.end();
  });

  it("keeps one immutable payload, leases once, retries, and ignores published duplicates", async () => {
    await enqueueSlackNotification(notification);
    await enqueueSlackNotification({ ...notification, title: "changed duplicate" });
    let calls = 0;
    const failingPublisher = async (payload: SlackNotification) => {
      calls++;
      expect(payload.title).toBe("Synthetic");
      throw new Error("synthetic transport unavailable");
    };
    await drainSlackNotifications(failingPublisher, notification.id);
    let record = (
      await pool.query("SELECT * FROM public.slack_notification_outbox WHERE notification_id=$1", [
        notification.id,
      ])
    ).rows[0];
    expect(record.status).toBe("pending");
    expect(record.attempts).toBe(1);
    await pool.query(
      "UPDATE public.slack_notification_outbox SET available_at=now() WHERE notification_id=$1",
      [notification.id]
    );
    const success = async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 30));
    };
    await Promise.all([
      drainSlackNotifications(success, notification.id),
      drainSlackNotifications(success, notification.id),
    ]);
    record = (
      await pool.query("SELECT * FROM public.slack_notification_outbox WHERE notification_id=$1", [
        notification.id,
      ])
    ).rows[0];
    expect(record.status).toBe("published");
    expect(record.attempts).toBe(2);
    expect(calls).toBe(2);
    await enqueueSlackNotification(notification);
    expect((await drainSlackNotifications(success, notification.id)).claimed).toBe(0);
  });
});
