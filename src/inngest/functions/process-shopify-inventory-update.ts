// ============================================================================
// PROCESS SHOPIFY INVENTORY UPDATE
// ============================================================================
// Resolves Shopify's inventory_item_id to the canonical SKU after the raw
// webhook has been persisted to the durable webhook inbox. The derived mesh
// events use the source webhook operation ID, so retries remain idempotent.

import { inngest } from "../client";
import { config } from "@/lib/config";
import { resolveShopifyInventorySku } from "@/lib/clients/shopify-inventory";
import { canonicalInventoryKey } from "@/lib/helpers/inventory-identity";
import { RETRY_CONFIGS } from "@/lib/utils/constants";

type ShopifyInventoryUpdateData = {
  sourceOperationId: string;
  inventoryItemId: string;
  locationId: string;
  available: number;
  updatedAt: string;
  shopifyStore: string;
};

export const processShopifyInventoryUpdate = inngest.createFunction(
  {
    id: "process-shopify-inventory-update",
    name: "Resolve Shopify Inventory Update",
    retries: RETRY_CONFIGS.DEFAULT,
    concurrency: [{ limit: 1, key: "event.data.inventoryItemId" }],
    triggers: [{ event: "shopify/inventory.updated" }],
  },
  async ({ event, step }: { event: { data: ShopifyInventoryUpdateData }; step: any }) => {
    if (!config.features.enableInventorySync) {
      return { status: "skipped", reason: "Inventory sync disabled" };
    }

    const data = event.data;
    const sku = await step.run("resolve-canonical-sku", () =>
      resolveShopifyInventorySku(
        { inventoryItemId: data.inventoryItemId },
        data.shopifyStore
      )
    );
    const inventoryKey = canonicalInventoryKey({ sku });

    for (const destination of ["dynamics", "gps"] as const) {
      await step.sendEvent(`dispatch-inventory-${destination}`, {
        id: `inventory-sync-shopify-${destination}-${data.sourceOperationId}`,
        name: "inventory/sync" as const,
        data: {
          source: "shopify" as const,
          destination,
          payload: {
            inventoryKey,
            sku,
            inventoryItemId: data.inventoryItemId,
            locationId: data.locationId,
            available: data.available,
            quantity: data.available,
            action: "update" as const,
            source: "shopify" as const,
            destination,
            timestamp: data.updatedAt,
          },
        },
      });
    }

    return { status: "queued", sku, inventoryKey, destinations: ["dynamics", "gps"] };
  }
);
