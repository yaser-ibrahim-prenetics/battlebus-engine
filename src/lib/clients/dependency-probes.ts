import { shopifyAdminGraphql } from "./shopify";
import { getInventory as dynamicsInventory } from "./dynamics";
import { getInventory as gpsInventory } from "./gps";
import { config } from "@/lib/config";

/** Read-only authenticated probes. Never use a mutation as a health check. */
export const dependencyProbes: Record<string, () => Promise<void>> = {
  shopify: async () => {
    const body = await shopifyAdminGraphql<{
      data?: { shop?: { id?: string } };
      errors?: unknown[];
    }>("query DependencyHealth { shop { id } }");
    if (body.errors?.length || !body.data?.shop?.id) throw new Error("Shopify access denied");
  },
  dynamics: async () => {
    await dynamicsInventory({ top: 1 });
  },
  gps_us: async () => {
    if (config.features.dryRunMode) throw new Error("Simulation is not a dependency probe");
    await gpsInventory({ pageSize: 1 }, "GPS Warehouse");
  },
  gps_uk: async () => {
    if (config.features.dryRunMode) throw new Error("Simulation is not a dependency probe");
    await gpsInventory({ pageSize: 1 }, "GPS UK Warehouse");
  },
};
