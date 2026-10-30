import { forwardInventoryRequest } from "@/lib/clients/inventory-service";

async function readAvailability(provider: "gps" | "d365", warehouse: string, skus: string[]) {
  if (!skus.length) return new Map<string, {available: number}>();
  const response = await forwardInventoryRequest(new Request("https://battle-bus.internal/api/inventory/availability", {
    method: "POST", headers: {"x-api-key": process.env.BATTLE_BUS_API_KEY || "", "content-type": "application/json"},
    body: JSON.stringify({provider, warehouse, skus}),
  }));
  if (!response.ok) throw new Error("Inventory availability service is unavailable");
  const data = await response.json() as {levels: Array<{sku: string; available: number}>};
  if (!Array.isArray(data.levels) || !data.levels.every(level => typeof level.sku === "string" && Number.isFinite(level.available))) {
    throw new Error("Invalid inventory availability response");
  }
  return new Map(data.levels.map(level => [level.sku, {available: level.available}]));
}
export const queryGpsWarehouseInventory = (warehouse: string, skus: string[]) => readAvailability("gps", warehouse, skus);
export const queryD365Inventory = (skus: string[], warehouse: string) => readAvailability("d365", warehouse, skus);
