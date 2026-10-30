import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  connect: vi.fn(),
}));

vi.mock("@/lib/db/database", () => ({
  getDatabasePool: vi.fn(async () => ({ connect: mocks.connect })),
}));

import { reserveOpenAiAdsReplayRequest } from "@/lib/services/operations/openai-ads-replay";

const request = {
  requestId: "00000000-0000-4000-8000-000000000001",
  actorId: "admin",
  actorEmail: "admin@example.com",
  reason: "Provider configuration was corrected",
  parameters: {
    operation: "replay_openai_ads",
    eventId: "bb_order_created_0000000000000000000000000000000000000000",
  },
};

describe("audited OpenAI Ads replay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
  });

  it("requeues one terminal conversion in the same audit transaction", async () => {
    // The request hash is intentionally opaque; capture it from the insert values.
    let savedHash = "";
    mocks.query.mockImplementation(async (sql: string, values: unknown[] = []) => {
      if (sql.includes("INSERT INTO public.openai_ads_replay_requests"))
        savedHash = String(values[1]);
      if (sql.includes("SELECT id, request_hash")) {
        return {
          rows: [
            {
              id: request.requestId,
              request_hash: savedHash,
              event_id: request.parameters.eventId,
              status: "pending",
              error_code: null,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM public.openai_ads_conversions") && sql.includes("FOR UPDATE")) {
        return {
          rows: [
            {
              event_id: request.parameters.eventId,
              status: "permanent_failure",
              replay_count: 2,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(reserveOpenAiAdsReplayRequest(request)).resolves.toEqual({
      requestId: request.requestId,
      eventId: request.parameters.eventId,
      status: "succeeded",
      errorCode: null,
      replayed: true,
    });
    const statements = mocks.query.mock.calls.map(([sql]) => String(sql));
    expect(statements[0]).toBe("BEGIN");
    expect(statements.some((sql) => sql.includes("SET status='queued'"))).toBe(true);
    expect(statements.at(-1)).toBe("COMMIT");
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("rejects active work and preserves an audit receipt", async () => {
    let savedHash = "";
    mocks.query.mockImplementation(async (sql: string, values: unknown[] = []) => {
      if (sql.includes("INSERT INTO public.openai_ads_replay_requests"))
        savedHash = String(values[1]);
      if (sql.includes("SELECT id, request_hash")) {
        return {
          rows: [
            {
              id: request.requestId,
              request_hash: savedHash,
              event_id: request.parameters.eventId,
              status: "pending",
              error_code: null,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM public.openai_ads_conversions") && sql.includes("FOR UPDATE")) {
        return {
          rows: [{ event_id: request.parameters.eventId, status: "delivering", replay_count: 0 }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(reserveOpenAiAdsReplayRequest(request)).resolves.toMatchObject({
      status: "rejected",
      errorCode: "conversion_not_replayable",
      replayed: false,
    });
    expect(
      mocks.query.mock.calls.some(([sql]) => String(sql).includes("SET status='queued'"))
    ).toBe(false);
    expect(mocks.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("rolls back a conflicting request identity", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id, request_hash")) {
        return {
          rows: [
            {
              id: request.requestId,
              request_hash: "f".repeat(64),
              event_id: request.parameters.eventId,
              status: "pending",
              error_code: null,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(reserveOpenAiAdsReplayRequest(request)).rejects.toThrow("conflicts");
    expect(mocks.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});
