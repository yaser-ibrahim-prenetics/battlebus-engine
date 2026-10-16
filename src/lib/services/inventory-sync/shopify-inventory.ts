import { config } from "../../config";
import type { InventoryLevel } from "./types";

function toShopifyLocationGid(locationId: string): string {
  return locationId.startsWith("gid://shopify/Location/")
    ? locationId
    : `gid://shopify/Location/${locationId}`;
}

/** Query Shopify inventory levels for the requested SKUs. */
export async function queryShopifyInventory(
  skus: string[],
  locationId?: string
): Promise<Map<string, InventoryLevel>> {
  console.log(`[InventorySync] Querying Shopify inventory for ${skus.length} SKUs`);

  const skuQuery = skus.map((sku) => `sku:${sku}`).join(" OR ");
  const query = `
    query getInventoryLevels($query: String!) {
      productVariants(first: 100, query: $query) {
        edges {
          node {
            sku
            inventoryItem {
              id
              inventoryLevels(first: 10) {
                edges {
                  node {
                    location { id }
                    quantities(names: ["available", "reserved", "incoming"]) {
                      name
                      quantity
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;
  const variables: Record<string, unknown> = { query: skuQuery };

  if (config.features.dryRunMode) {
    console.log("[InventorySync] DRY RUN - Would query Shopify inventory");
    return new Map();
  }

  const response = await fetch(
    `https://${config.shopify.im8.shopDomain}/admin/api/${config.shopify.im8.apiVersion}/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": config.shopify.im8.accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Shopify inventory query failed: ${response.status} - ${error}`);
  }

  const data = await response.json();
  if (data.errors) {
    console.error("[InventorySync] Shopify GraphQL errors:", data.errors);
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(data.errors)}`);
  }

  const result = new Map<string, InventoryLevel>();
  const variants = data.data?.productVariants?.edges || [];
  const requestedLocationGid = locationId ? toShopifyLocationGid(locationId) : undefined;

  for (const { node: variant } of variants) {
    const sku = variant.sku;
    if (!sku) continue;

    let totalAvailable = 0;
    let totalReserved = 0;
    let totalIncoming = 0;

    for (const { node: level } of variant.inventoryItem?.inventoryLevels?.edges || []) {
      if (requestedLocationGid && String(level.location.id) !== requestedLocationGid) continue;

      for (const quantity of level.quantities || []) {
        switch (quantity.name) {
          case "available":
            totalAvailable += quantity.quantity || 0;
            break;
          case "reserved":
            totalReserved += quantity.quantity || 0;
            break;
          case "incoming":
            totalIncoming += quantity.quantity || 0;
            break;
        }
      }
    }

    result.set(sku, {
      sku,
      available: totalAvailable,
      reserved: totalReserved,
      inTransit: totalIncoming,
      lastUpdated: new Date(),
    });
  }

  console.log(`[InventorySync] Shopify returned ${result.size} inventory items`);
  return result;
}
