import { NextRequest } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";

const { enqueue, drain, query, publish, slack } = vi.hoisted(() => ({
  enqueue: vi.fn(),
  drain: vi.fn(),
  query: vi.fn(),
  publish: vi.fn(),
  slack: { integration: "real", transport: "pubsub", publishEnabled: true, appEnv: "test" },
}));
vi.mock("@/lib/config", () => ({ config: { slack } }));
vi.mock("@/lib/db/database", () => ({ queryDatabase: query }));
vi.mock("@/lib/clients/slack-pubsub", () => ({ publishSlackToPubSub: publish }));
vi.mock("@/lib/services/slack-notifications/outbox", () => ({
  enqueueSlackNotification: enqueue,
  drainSlackNotifications: drain,
}));
import { POST } from "../route";
import { queueSlackTest } from "@/lib/services/slack-notifications/test-notification";

beforeEach(() => {
  vi.resetAllMocks();
  process.env.BATTLE_BUS_API_KEY = "isolated-slack-test-key";
  Object.assign(slack, { integration: "real", transport: "pubsub", publishEnabled: true });
  enqueue.mockResolvedValue(undefined);
  drain.mockResolvedValue({ claimed: 1, published: 1, failed: 0 });
  query.mockResolvedValue({ rows: [{ status: "published" }] });
});
const request = (authenticated = true) =>
  new NextRequest("http://localhost/api/integration/slack/test", {
    method: "POST",
    headers: authenticated ? { Authorization: "Bearer isolated-slack-test-key" } : {},
    body: JSON.stringify({ channel: "arbitrary", summary: "@channel", id: "untrusted" }),
  });

it("rejects unauthorized and unconfigured service authentication before enqueue", async () => {
  expect((await POST(request(false))).status).toBe(401);
  delete process.env.BATTLE_BUS_API_KEY;
  expect((await POST(request())).status).toBe(500);
  expect(enqueue).not.toHaveBeenCalled();
});
it.each([
  { publishEnabled: false },
  { transport: "webhook" },
  { transport: "kafka" },
  { integration: "mock" },
])("never queues or publishes when test transport is disabled: %j", async (settings) => {
  Object.assign(slack, settings);
  expect((await POST(request())).status).toBe(503);
  expect(enqueue).not.toHaveBeenCalled();
  expect(drain).not.toHaveBeenCalled();
});
it("uses fixed content and the durable publisher, never browser-supplied text or channels", async () => {
  const response = await POST(request());
  expect(response.status).toBe(202);
  const result = await response.json();
  expect(result.status).toBe("published");
  expect(enqueue.mock.calls[0][0]).toMatchObject({
    channel: "system",
    title: "Battle Hub Slack notification test",
    id: result.notificationId,
  });
  expect(JSON.stringify(enqueue.mock.calls[0][0])).not.toContain("@channel");
  expect(drain).toHaveBeenCalledWith(publish, result.notificationId);
});
it("reuses the same database deduplication key within a minute across requests", async () => {
  const now = Date.parse("2026-10-27T09:00:01Z");
  const first = await queueSlackTest(now);
  const repeated = await queueSlackTest(now + 1000);
  const next = await queueSlackTest(now + 60_000);
  expect(first).toEqual(repeated);
  expect(next).not.toEqual(first);
  expect(first).toMatchObject({ nextTestAt: "2026-10-27T09:01:00.000Z" });
});
it.each(["pending", "publishing"])("reports %s as queued, not delivered", async (status) => {
  query.mockResolvedValue({ rows: [{ status }] });
  drain.mockResolvedValue({ claimed: 1, published: 0, failed: 1 });
  expect(await (await POST(request())).json()).toMatchObject({ status: "queued" });
});
it("does not acknowledge persistence or status failures as success or expose provider errors", async () => {
  enqueue.mockRejectedValueOnce(new Error("sensitive connection value"));
  const response = await POST(request());
  expect(response.status).toBe(503);
  expect(JSON.stringify(await response.json())).not.toContain("sensitive");
  expect(drain).not.toHaveBeenCalled();
  query.mockResolvedValue({ rows: [] });
  expect((await POST(request())).status).toBe(503);
  query.mockResolvedValue({ rows: [{ status: "dead_letter" }] });
  expect((await POST(request())).status).toBe(503);
});
