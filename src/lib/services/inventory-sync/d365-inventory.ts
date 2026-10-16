import * as dynamics from "../../clients/dynamics";
import { config } from "../../config";
import { mapShopifySkuToDynamicsForOrderLine } from "../../transformers/sku";
import type { InventoryLevel } from "./types";

/** Query D365 on-hand inventory through the InventoryOnHandEntities OData endpoint. */
export async function queryD365Inventory(
  skus: string[],
  dataAreaId: string = config.dynamics.dataAreaId
): Promise<Map<string, InventoryLevel>> {
  console.log(`[InventorySync] Querying D365 inventory for ${skus.length} SKUs`);

  const d365Skus = skus.map((sku) => mapShopifySkuToDynamicsForOrderLine(sku));
  const skuFilter = d365Skus.map((sku) => `ItemNumber eq '${sku}'`).join(" or ");
  const filter = `dataAreaId eq '${dataAreaId}' and (${skuFilter})`;
  const token = await dynamics.authenticate();
  const url = `${config.dynamics.baseUrl}/data/InventoryOnHandEntities?$filter=${encodeURIComponent(filter)}&$select=ItemNumber,AvailablePhysical,ReservedOrdered,OrderedInTotal`;

  console.log(`[InventorySync] D365 inventory query: ${url}`);

  if (config.features.dryRunMode) {
    console.log("[InventorySync] DRY RUN - Would query D365 inventory");
    return new Map();
  }

  const response = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json" },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`D365 inventory query failed: ${response.status} - ${error}`);
  }

  const data = await response.json();
  const items = data.value || [];
  const result = new Map<string, InventoryLevel>();

  for (const item of items) {
    const d365Sku = item.ItemNumber;
    const originalSku =
      skus.find((sku) => mapShopifySkuToDynamicsForOrderLine(sku) === d365Sku) || d365Sku;

    result.set(originalSku, {
      sku: originalSku,
      available: item.AvailablePhysical || 0,
      reserved: item.ReservedOrdered || 0,
      inTransit: item.OrderedInTotal || 0,
      lastUpdated: new Date(),
    });
  }

  console.log(`[InventorySync] D365 returned ${result.size} inventory items`);
  return result;
}
