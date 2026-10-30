import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  channelLift: { enabled: true, sendEnabled: false, maxBackfillDays: 31 },
}));

vi.mock("@/inngest/client", () => ({ inngest: { send: mocks.send } }));
vi.mock("@/lib/config", () => ({ config: { channelLift: mocks.channelLift } }));

import { POST } from "@/app/api/operations/channel-lift/route";

function request(body: unknown, apiKey?: string): NextRequest {
  return new NextRequest("https://battle-bus.example/api/operations/channel-lift", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { "x-api-key": apiKey } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("channel-lift operations route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BATTLE_BUS_OPERATIONS_API_KEY = "operations-key";
    mocks.channelLift.enabled = true;
    mocks.channelLift.sendEnabled = false;
    mocks.send.mockResolvedValue(undefined);
  });

  it("fails closed before queueing unauthenticated work", async () => {
    const response = await POST(request({}));
    expect(response.status).toBe(401);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("queues an authenticated inclusive dry-run backfill with stable request IDs", async () => {
    const response = await POST(
      request(
        {
          requestId: "ca90cc5c-b1a2-4245-8ea4-bc57a10481ed",
          reasonCode: "parity_validation",
          referenceId: "BB-123",
          startDate: "2026-10-01",
          endDate: "2026-10-03",
        },
        "operations-key"
      )
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: "queued", mode: "dry_run", count: 3 });
    expect(mocks.send).toHaveBeenCalledTimes(3);
    expect(mocks.send.mock.calls[0][0]).toMatchObject({
      id: "channel-lift:manual:ca90cc5c-b1a2-4245-8ea4-bc57a10481ed:2026-10-01:dry_run",
      name: "meta.channel-lift/run.requested",
      data: { reportingDate: "2026-10-01", mode: "dry_run", source: "manual" },
    });
  });

  it("rejects live delivery while the independent kill switch is off", async () => {
    const response = await POST(
      request(
        {
          requestId: "ca90cc5c-b1a2-4245-8ea4-bc57a10481ed",
          reasonCode: "live_canary",
          referenceId: "BB-124",
          date: "2026-10-01",
          live: true,
        },
        "operations-key"
      )
    );
    expect(response.status).toBe(403);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("rejects free-text audit narratives before they reach Inngest", async () => {
    const response = await POST(
      request(
        {
          requestId: "ca90cc5c-b1a2-4245-8ea4-bc57a10481ed",
          reason: "Customer email person@example.com requested a replay",
          date: "2026-10-01",
        },
        "operations-key"
      )
    );
    expect(response.status).toBe(400);
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
