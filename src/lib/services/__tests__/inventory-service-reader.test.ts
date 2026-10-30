import { beforeEach, expect, it, vi } from "vitest";
const forward = vi.hoisted(() => vi.fn());
vi.mock("@/lib/clients/inventory-service", () => ({forwardInventoryRequest: forward}));
import { queryD365Inventory, queryGpsWarehouseInventory } from "../inventory-sync";
beforeEach(() => vi.clearAllMocks());
it("preserves warehouse scope for order recovery reads", async () => {
  forward.mockResolvedValue(new Response('{"levels":[{"sku":"SKU-1","available":7}]}'));
  expect((await queryGpsWarehouseInventory("GPS UK Warehouse", ["SKU-1"])).get("SKU-1")?.available).toBe(7);
  expect(await forward.mock.calls[0][0].json()).toEqual({provider: "gps", warehouse: "GPS UK Warehouse", skus: ["SKU-1"]});
});
it("does not treat an unavailable inventory service as successful stock data", async () => {
  forward.mockResolvedValue(new Response('{}', {status: 502}));
  await expect(queryD365Inventory(["SKU-1"], "U001")).rejects.toThrow("unavailable");
});
it("rejects malformed inventory levels", async () => {
  forward.mockResolvedValue(new Response('{"levels":[{"sku":"SKU-1","available":"unknown"}]}'));
  await expect(queryD365Inventory(["SKU-1"], "U001")).rejects.toThrow("Invalid");
});
