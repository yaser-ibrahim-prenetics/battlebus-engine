import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forwardInventoryRequest } from "../inventory-service";

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubEnv("BATTLE_BUS_API_KEY", "caller-key");
  vi.stubEnv("INVENTORY_SERVICE_API_KEY", "inventory-key");
  vi.stubEnv("INVENTORY_SERVICE_URL", "https://inventory.example.com");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function request(key = "caller-key") {
  return new Request("https://bus.example.com/api/inventory/sync?from=gps&to=shopify", {
    method: "POST", headers: { "x-api-key": key, "content-type": "application/json",
      "idempotency-key": "adjustment-123" }, body: JSON.stringify({sku: "SKU-1", quantity: 2}),
  });
}
describe("inventory compatibility routing", () => {
  it("rejects unauthorized requests before calling inventory", async () => {
    expect((await forwardInventoryRequest(request("wrong"))).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("preserves the operation and downstream status while replacing caller credentials", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ids: ["id-1"]}), {status: 202}));
    const response = await forwardInventoryRequest(request());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ids: ["id-1"]});
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://inventory.example.com/api/inventory/sync?from=gps&to=shopify");
    expect(options.headers.get("x-api-key")).toBe("inventory-key");
    expect(options.headers.get("idempotency-key")).toBe("adjustment-123");
    expect(JSON.parse(options.body)).toEqual({sku: "SKU-1", quantity: 2});
    expect(options.redirect).toBe("error");
  });
  it("returns a retryable error without leaking upstream details", async () => {
    fetchMock.mockRejectedValue(new Error("private credentials"));
    const response = await forwardInventoryRequest(request());
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("private credentials");
  });
  it("fails closed when the service has not been configured", async () => {
    vi.stubEnv("INVENTORY_SERVICE_URL", "");
    expect((await forwardInventoryRequest(request())).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects origins containing credentials or an unexpected path", async () => {
    vi.stubEnv("INVENTORY_SERVICE_URL", "https://user:secret@example.com/unexpected");
    expect((await forwardInventoryRequest(request())).status).toBe(502);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
