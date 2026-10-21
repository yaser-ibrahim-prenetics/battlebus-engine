import { buildShopifyUrl, getShopifyHeaders } from "./shopify/request";
import { getInventory as dynamicsInventory } from "./dynamics";
import { getInventory as gpsInventory } from "./gps";
import { config } from "@/lib/config";

/** Read-only authenticated probes. Never use a mutation as a health check. */
export const dependencyProbes: Record<string, () => Promise<void>> = {
  shopify: async () => {
    const response = await fetch(buildShopifyUrl("/graphql.json"), {
      method: "POST",
      headers: getShopifyHeaders(),
      body: JSON.stringify({ query: "query DependencyHealth { shop { id } }" }),
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Shopify unavailable");
    const body = await response.json();
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
