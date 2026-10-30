import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forwardInventoryRequest, forwardInventoryInngestRequest } from "../inventory-service";

vi.mock("google-auth-library", () => ({
  GoogleAuth: class { async getIdTokenClient() {
    return { idTokenProvider: { fetchIdToken: async () => "cloud-run-identity" } };
  } },
}));
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
  it.each(["d365", "unified"])("routes the %s read API through inventory-service", async (path) => {
    fetchMock.mockResolvedValue(new Response('{"items":[]}'));
    const response = await forwardInventoryRequest(new Request(`https://bus.example.com/api/inventory/${path}?sku=SKU-1`, {
      headers: {"x-api-key": "caller-key"},
    }));
    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe(`https://inventory.example.com/api/inventory/${path}?sku=SKU-1`);
  });
  it("preserves signed Inngest callback bytes and query parameters for worker verification", async () => {
    const body = '{ "event": {"id":"probe"} }';
    fetchMock.mockResolvedValue(new Response("{}", {headers: {"x-inngest-sdk": "test"}}));
    const response = await forwardInventoryInngestRequest(new Request(
      "https://bus.example.com/api/inventory/inngest?fnId=inventory-probe&stepId=step", {
        method: "POST", body, headers: {"x-inngest-signature": "signed-payload"},
      }));
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://inventory.example.com/api/inngest?fnId=inventory-probe&stepId=step");
    expect(options.body).toBe(body);
    expect(options.headers.get("x-inngest-signature")).toBe("signed-payload");
    expect(response.headers.get("x-inngest-sdk")).toBe("test");
  });
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
    expect(options.headers.get("authorization")).toBe("Bearer cloud-run-identity");
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
