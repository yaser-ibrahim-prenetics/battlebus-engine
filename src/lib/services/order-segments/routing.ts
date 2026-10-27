import type { ShopifyOrderPayload } from "@/inngest/events";
import type { IShopifyFulfillmentOrder } from "@/lib/types/shopify";
import { getWarehouseConfig, type WarehouseName } from "@/lib/helpers/warehouse";
import {
  getWarehouseNameForLocation,
  getDataAreaIdForLocationAndCountry,
  resolveStordEuOverrideForMappedLocation,
  resolveStordHubWhenFulfillmentLocationUnmapped,
} from "../location-routing";

/** Apply the same country overrides and STORD fallback as parent order preparation. */
export async function resolveSegmentRouting(
  order: ShopifyOrderPayload,
  fo: IShopifyFulfillmentOrder,
  country: string
) {
  const location = String(fo.assigned_location_id);
  let warehouse = await getWarehouseNameForLocation(location);
  let dataAreaId = await getDataAreaIdForLocationAndCountry(location, country);
  const eu = await resolveStordEuOverrideForMappedLocation(warehouse, country, "im8");
  if (eu) {
    warehouse = eu.warehouseName;
    dataAreaId = eu.dataAreaId;
  }
  if (!warehouse || !dataAreaId) {
    const segmentOrder = {
      ...order,
      line_items: order.line_items.filter((line) =>
        fo.line_items.some((item) => String(item.line_item_id) === String(line.id))
      ),
    };
    const fallback = await resolveStordHubWhenFulfillmentLocationUnmapped(
      segmentOrder,
      country,
      "im8"
    );
    if (fallback) {
      warehouse = fallback.warehouseName;
      dataAreaId = fallback.dataAreaId;
    }
  }
  if (!warehouse || !dataAreaId || warehouse.toLowerCase().includes("virtual"))
    throw new Error(`Incomplete routing for segment location ${location}`);
  getWarehouseConfig(warehouse as WarehouseName);
  return { warehouse: warehouse as WarehouseName, dataAreaId };
}
