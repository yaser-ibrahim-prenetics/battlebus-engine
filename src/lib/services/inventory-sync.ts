import { requestInventoryService } from "@/lib/clients/inventory-service";

async function readAvailability(provider: "gps" | "d365", warehouse: string, skus: string[]) {
  const levels = new Map<string, {available: number}>();
  // Recovery batches count orders, not distinct SKUs. Bound each provider request independently.
  for (let offset = 0; offset < skus.length; offset += 100) {
    const response = await requestInventoryService("/api/inventory/availability", {
      method: "POST", headers: new Headers({"content-type": "application/json"}),
      body: JSON.stringify({provider, warehouse, skus: skus.slice(offset, offset + 100)}),
    });
    if (!response.ok) throw new Error("Inventory availability service is unavailable");
    const data = await response.json() as {levels: Array<{sku: string; available: number}>};
    if (!Array.isArray(data.levels) || !data.levels.every(level => typeof level.sku === "string" && Number.isFinite(level.available))) {
      throw new Error("Invalid inventory availability response");
    }
    for (const level of data.levels) levels.set(level.sku, {available: level.available});
  }
  return levels;
}
export const queryGpsWarehouseInventory = (warehouse: string, skus: string[]) => readAvailability("gps", warehouse, skus);
export const queryD365Inventory = (skus: string[], warehouse: string) => readAvailability("d365", warehouse, skus);
