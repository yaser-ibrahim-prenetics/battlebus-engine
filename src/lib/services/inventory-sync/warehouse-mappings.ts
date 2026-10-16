import { config } from "../../config";
import { getLocationIdForWarehouse } from "../location-routing";
import type { WarehouseMapping } from "./types";

let warehouseMappingsCache: WarehouseMapping[] | null = null;

export async function getWarehouseMappings(): Promise<WarehouseMapping[]> {
  if (warehouseMappingsCache) return warehouseMappingsCache;

  const [gpsLocationId, gpsUkLocationId] = await Promise.all([
    getLocationIdForWarehouse("GPS Warehouse"),
    getLocationIdForWarehouse("GPS UK Warehouse"),
  ]);

  warehouseMappingsCache = [
    {
      gpsName: "GPS Warehouse",
      gpsCode: "JFK01W",
      d365DataAreaId: "U001",
      d365WarehouseId: "USOPS-WH04",
      d365SiteId: "Prenetics",
      shopifyLocationId: gpsLocationId || config.shopify.im8.locations?.gps || "",
    },
    {
      gpsName: "GPS UK Warehouse",
      gpsCode: "GB03RS",
      d365DataAreaId: "H007",
      d365WarehouseId: "OPS-WH02",
      d365SiteId: "Prenetics",
      shopifyLocationId: gpsUkLocationId || config.shopify.im8.locations?.gpsUk || "",
    },
  ];

  return warehouseMappingsCache;
}

export async function getWarehouseMapping(
  identifier: string
): Promise<WarehouseMapping | undefined> {
  const mappings = await getWarehouseMappings();
  return mappings.find(
    (mapping) =>
      mapping.gpsName === identifier ||
      mapping.gpsCode === identifier ||
      mapping.d365DataAreaId.toUpperCase() === identifier.toUpperCase() ||
      mapping.d365WarehouseId === identifier ||
      mapping.shopifyLocationId === identifier
  );
}
