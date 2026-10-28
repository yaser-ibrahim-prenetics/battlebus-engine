import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { queryDatabase, deepReadiness, reserveRecoveryRequest, send, logRecoveryFailure } =
  vi.hoisted(() => ({
    queryDatabase: vi.fn(),
    deepReadiness: vi.fn(),
    reserveRecoveryRequest: vi.fn(),
    send: vi.fn(),
    logRecoveryFailure: vi.fn(),
  }));

vi.mock("@/lib/db/database", () => ({ queryDatabase }));
vi.mock("@/lib/services/operations/health", () => ({ deepReadiness }));
vi.mock("@/lib/services/operations/commands", () => ({ reserveRecoveryRequest }));
vi.mock("@/lib/services/operations/diagnostics", () => ({ logRecoveryFailure }));
vi.mock("@/inngest/client", () => ({ inngest: { send } }));

import { GET, POST } from "../route";

const originalApiKey = process.env.BATTLE_BUS_API_KEY;
const request = (method: "GET" | "POST", authorized = true) =>
  new NextRequest("http://localhost/api/operations?view=inbox", {
    method,
    headers: authorized
      ? { authorization: "Bearer operations-key", "content-type": "application/json" }
      : { "content-type": "application/json" },
    ...(method === "POST" ? { body: JSON.stringify({ operation: "test" }) } : {}),
  });

beforeEach(() => {
  process.env.BATTLE_BUS_API_KEY = "operations-key";
  vi.clearAllMocks();
  queryDatabase.mockResolvedValue({ rows: [{ id: "inbox" }] });
  reserveRecoveryRequest.mockResolvedValue({ requestId: "request-id", status: "queued" });
  send.mockResolvedValue(undefined);
});

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.BATTLE_BUS_API_KEY;
  else process.env.BATTLE_BUS_API_KEY = originalApiKey;
});

describe("operations route authentication", () => {
  it("rejects unauthenticated reads and writes before touching dependencies", async () => {
    expect((await GET(request("GET", false))).status).toBe(401);
    expect((await POST(request("POST", false))).status).toBe(401);
    expect(queryDatabase).not.toHaveBeenCalled();
    expect(reserveRecoveryRequest).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("allows authenticated reads and writes to reach their dependencies", async () => {
    const getResponse = await GET(request("GET"));
    const postResponse = await POST(request("POST"));

    expect(getResponse.status).toBe(200);
    expect(await getResponse.json()).toEqual({ rows: [{ id: "inbox" }] });
    expect(queryDatabase).toHaveBeenCalledOnce();
    expect(postResponse.status).toBe(202);
    expect(reserveRecoveryRequest).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
  });
});
