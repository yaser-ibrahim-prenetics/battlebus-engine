import { beforeEach, expect, it, vi } from "vitest";
const forward = vi.hoisted(() => vi.fn());
vi.mock("@/lib/clients/inventory-service", () => ({requestInventoryService: forward}));
import { queryD365Inventory, queryGpsWarehouseInventory } from "../inventory-sync";
beforeEach(() => vi.clearAllMocks());
it("preserves warehouse scope for order recovery reads", async () => {
  forward.mockResolvedValue(new Response('{"levels":[{"sku":"SKU-1","available":7}]}'));
  expect((await queryGpsWarehouseInventory("GPS UK Warehouse", ["SKU-1"])).get("SKU-1")?.available).toBe(7);
  expect(JSON.parse(forward.mock.calls[0][1].body)).toEqual({provider: "gps", warehouse: "GPS UK Warehouse", skus: ["SKU-1"]});
});
it("does not treat an unavailable inventory service as successful stock data", async () => {
  forward.mockResolvedValue(new Response('{}', {status: 502}));
  await expect(queryD365Inventory(["SKU-1"], "U001")).rejects.toThrow("unavailable");
});
it("rejects malformed inventory levels", async () => {
  forward.mockResolvedValue(new Response('{"levels":[{"sku":"SKU-1","available":"unknown"}]}'));
  await expect(queryD365Inventory(["SKU-1"], "U001")).rejects.toThrow("Invalid");
});

it("chunks more than 500 SKUs and merges availability without depending on inbound API credentials", async () => {
  const skus = Array.from({length: 501}, (_, i) => `SKU-${i}`);
  forward.mockImplementation(async (_path, options) => new Response(JSON.stringify({
    levels: JSON.parse(options.body).skus.map((sku: string) => ({sku, available: 2})),
  })));
  const levels = await queryD365Inventory(skus, "U001");
  expect(levels.size).toBe(501);
  expect(forward).toHaveBeenCalledTimes(6);
  for (const [, options] of forward.mock.calls) expect(JSON.parse(options.body).skus.length).toBeLessThanOrEqual(100);
  expect(levels.get("SKU-500")).toEqual({available: 2});
});
