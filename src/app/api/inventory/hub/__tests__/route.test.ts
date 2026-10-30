import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ send: vi.fn(), mappings: vi.fn() }));
vi.mock("@/lib/clients/hub-transport", () => ({sendHubWebhook: mocks.send, readHubLocationMappings: mocks.mappings}));
import { GET, POST } from "../route";
beforeEach(() => { vi.stubEnv("INVENTORY_SERVICE_API_KEY", "inventory-key"); vi.clearAllMocks(); });
afterEach(() => vi.unstubAllEnvs());
function request(path: string, key = "inventory-key") {
  return new Request(`https://bus.example/api/inventory/hub?path=${encodeURIComponent(path)}`, {
    method: "POST", headers: {"x-api-key": key}, body: JSON.stringify({event: "integration.probe", id: "probe-1"}),
  });
}
it("does not let inventory send order callbacks", async () => {
  expect((await POST(request("/api/webhooks/orders"))).status).toBe(400);
  expect(mocks.send).not.toHaveBeenCalled();
});
it("requires the inventory credential before making Hub requests", async () => {
  expect((await POST(request("/api/webhooks/probe", "wrong"))).status).toBe(401);
  expect(mocks.send).not.toHaveBeenCalled();
});
it("relays only an allowed callback through the trusted Hub transport", async () => {
  mocks.send.mockResolvedValue(new Response('{"ok":true}', {status: 200}));
  expect((await POST(request("/api/webhooks/probe"))).status).toBe(200);
  expect(mocks.send).toHaveBeenCalledWith("/api/webhooks/probe", {event: "integration.probe", id: "probe-1"});
});
it("restricts GET to the location mapping read", async () => {
  mocks.mappings.mockResolvedValue(new Response('{"locations":[]}'));
  const response = await GET(new Request("https://bus.example/api/inventory/hub", {headers: {"x-api-key": "inventory-key"}}));
  expect(await response.json()).toEqual({locations: []});
  expect(mocks.mappings).toHaveBeenCalledOnce();
});
