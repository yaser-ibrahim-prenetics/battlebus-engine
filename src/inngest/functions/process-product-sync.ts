// ============================================================================
// SHOPIFY PRODUCT → D365 & GPS SYNC
// ============================================================================
// Processes Shopify product create/update webhooks
// 1. Extracts product + variant data
// 2. Syncs to D365 (placeholder)
// 3. Syncs to GPS (placeholder)

import { inngest } from "../client";
import type { ShopifyProductPayload } from "../events";
import * as dynamics from "@/lib/clients/dynamics";
import * as gps from "@/lib/clients/gps";
import * as slack from "@/lib/clients/slack";
import * as csPlatform from "@/lib/clients/cs-platform";
import * as shopify from "@/lib/clients/shopify";
import { SlackChannelEnum } from "@/lib/types/slack";
import { RETRY_CONFIGS } from "@/lib/utils/constants";
import { logFlowEvent } from "@/lib/services/flow-logs";
import { isDatabaseConfigured, queryDatabase } from "@/lib/db/database";
import { canonicalInventoryKey } from "@/lib/helpers/inventory-identity";

type DeletedProductInventoryTarget = {
  sku?: string;
  inventoryItemId?: string;
  variantId?: string;
  locationId?: string;
  warehouseName?: string;
};

export async function resolveDeletedProductInventoryTargets(
  productId: string,
  product: ShopifyProductPayload
): Promise<DeletedProductInventoryTarget[]> {
  if (isDatabaseConfigured()) {
    try {
      const retained = await queryDatabase<{
        sku: string;
        shopify_inventory_item_id: string | number | null;
        shopify_variant_id: string | number | null;
        location_id: string | null;
        warehouse: string | null;
      }>(
        `SELECT sku, shopify_inventory_item_id, shopify_variant_id, location_id, warehouse
         FROM public.stocks
         WHERE shopify_product_id = $1`,
        [productId]
      );
      if (retained.rows.length > 0) {
        return retained.rows.map((row) => ({
          sku: row.sku,
          inventoryItemId: row.shopify_inventory_item_id
            ? String(row.shopify_inventory_item_id)
            : undefined,
          variantId: row.shopify_variant_id ? String(row.shopify_variant_id) : undefined,
          locationId: row.location_id || undefined,
          warehouseName: row.warehouse || undefined,
        }));
      }
    } catch (error) {
      console.warn(
        `[ProductSync] Could not load retained stock for deleted product ${productId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return (product.variants || [])
    .map((variant) => ({
      sku: variant.sku || undefined,
      inventoryItemId: variant.inventory_item_id
        ? String(variant.inventory_item_id)
        : undefined,
      variantId: variant.id ? String(variant.id) : undefined,
    }))
    .filter((target) => target.sku || target.inventoryItemId || target.variantId);
}

export const processProductSync = inngest.createFunction(
  {
    id: "process-product-sync",
    name: "Process Shopify Product Sync",
    retries: RETRY_CONFIGS.DEFAULT,
    concurrency: [{ limit: 5 }],
    triggers: [
      { event: "shopify/product.created" },
      { event: "shopify/product.updated" },
      { event: "shopify/product.deleted" },
    ],
  },
  async ({ event, step }: { event: any; step: any }) => {
    const _flowStart = Date.now();
    const _runId = (event as any).id;
    const { productId, productTitle, shopifyStore, productJson } = event.data;
    const product = productJson as ShopifyProductPayload;

    logFlowEvent({
      flow: "product_sync",
      step: "start",
      status: "started",
      runId: _runId,
      shopifyOrderId: event.data?.shopifyOrderId,
      shopifyOrderName: event.data?.shopifyOrderName,
      payload: { productId, productTitle, shopifyStore, eventName: event.name },
    });

    console.log(`[ProductSync] ========================================`);
    console.log(
      `[ProductSync] Processing product: ${productTitle} (${productId}) from ${shopifyStore}`
    );
    console.log(`[ProductSync] Event: ${event.name}`);

    // Handle deletion
    if (event.name === "shopify/product.deleted") {
      console.log(`[ProductSync] Product deletion detected - zeroing retained inventory`);
      const targets = await step.run("resolve-deleted-product-inventory", () =>
        resolveDeletedProductInventoryTargets(String(productId), product)
      );
      if (targets.length === 0) {
        throw new Error(`No retained variants found for deleted Shopify product ${productId}`);
      }

      for (const [index, target] of targets.entries()) {
        for (const destination of ["dynamics", "gps"] as const) {
          await step.sendEvent(`zero-deleted-product-${index}-${destination}`, {
            id: `product-delete-zero-${productId}-${target.locationId || "all"}-${target.sku || target.inventoryItemId || target.variantId}-${destination}`,
            name: "inventory/sync" as const,
            data: {
              source: "shopify",
              destination,
              payload: {
                inventoryKey: canonicalInventoryKey(target),
                ...target,
                quantity: 0,
                available: 0,
                action: "delete" as const,
                source: "shopify",
                destination,
                reason: "shopify_product_deleted",
                timestamp: event.data.receivedAt || new Date().toISOString(),
              },
            },
          });
        }
      }

      const d365Result = {
        success: true,
        message: `Queued ${targets.length} zero-stock update(s) for D365`,
      };
      const gpsResult = {
        success: true,
        message: `Queued ${targets.length} zero-stock update(s) for GPS`,
      };

      // Notify Battle Hub only after every durable zero-stock event is queued.
      await step.run("notify-battle-hub-product-deleted", async () => {
        console.log(`[ProductSync] Notifying Battle Hub of product deletion...`);
        await csPlatform.sendProductDeleted({
          productId,
          productTitle: product.title || productTitle,
          shopifyStore,
          d365Result,
          gpsResult,
        });
      });

      logFlowEvent({
        flow: "product_sync",
        step: "done",
        status: "completed",
        runId: _runId,
        durationMs: Date.now() - _flowStart,
        shopifyOrderId: event.data?.shopifyOrderId,
        shopifyOrderName: event.data?.shopifyOrderName,
        payload: { productId, productTitle, shopifyStore, deleted: true },
      });

      return {
        status: "deleted",
        productId,
        productTitle,
        d365Result,
        gpsResult,
        processedAt: new Date().toISOString(),
      };
    }

    // Extract variant data for syncing
    const variants = (product.variants || []).map((v) => ({
      sku: v.sku,
      price: v.price,
      barcode: v.barcode,
      weight: v.weight,
      weight_unit: v.weight_unit,
      inventory_quantity: v.inventory_quantity,
      inventory_item_id: v.inventory_item_id,
      variant_id: v.id,
      title: v.title,
    }));

    // Step 1: Sync product to D365
    const d365Result = await step.run("sync-product-to-d365", async () => {
      console.log(`[ProductSync] Syncing product to D365...`);
      return dynamics.syncProduct({
        productId,
        title: productTitle,
        variants,
        vendor: product.vendor,
        productType: product.product_type,
        tags: product.tags,
        status: product.status,
      });
    });

    console.log(`[ProductSync] D365 result: ${d365Result.message}`);

    // Step 2: Sync product to GPS
    const gpsResult = await step.run("sync-product-to-gps", async () => {
      console.log(`[ProductSync] Syncing product to GPS...`);
      return gps.syncProduct({
        productId,
        title: productTitle,
        variants: variants.map((v) => ({
          sku: v.sku,
          barcode: v.barcode,
          weight: v.weight,
          weight_unit: v.weight_unit,
        })),
      });
    });

    console.log(`[ProductSync] GPS result: ${gpsResult.message}`);

    // Step 3: Fetch location-wise inventory from Shopify
    const inventoryLevelsByVariant = await step.run("fetch-shopify-inventory-levels", async () => {
      const levelsMap: Record<
        number,
        Array<{
          location_id: string;
          location_name: string;
          available: number;
          reserved: number;
          committed: number;
        }>
      > = {};

      for (const variant of variants) {
        if (variant.inventory_item_id) {
          try {
            const levels = await shopify.getInventoryLevelsByLocation(variant.inventory_item_id);
            levelsMap[variant.inventory_item_id] = levels;
          } catch (error) {
            // If fetch fails, continue without location breakdown
            console.warn(
              "[ProductSync] Location breakdown fetch failed, continuing:",
              error instanceof Error ? error.message : error
            );
          }
        }
      }

      return levelsMap;
    });

    // Step 4: Notify Battle Hub (always send, even if D365/GPS sync failed)
    await step.run("notify-battle-hub-product-sync", async () => {
      const isCreate = event.name === "shopify/product.created";
      // Map variants to convert null to undefined for barcode (TypeScript type compatibility)
      const mappedVariants = variants.map((v) => ({
        sku: v.sku,
        price: v.price,
        barcode: v.barcode ?? undefined, // Convert null to undefined
        weight: v.weight,
        weight_unit: v.weight_unit,
        inventory_quantity: v.inventory_quantity, // Total aggregate from Shopify
        inventory_item_id: v.inventory_item_id,
        variant_id: v.variant_id,
        title: v.title,
        inventory_levels: inventoryLevelsByVariant[v.inventory_item_id] || [], // Location-wise breakdown
      }));

      const productData = {
        productId,
        productTitle,
        shopifyStore,
        variants: mappedVariants,
        vendor: product.vendor,
        productType: product.product_type,
        tags: product.tags,
        status: product.status,
        d365Result,
        gpsResult,
      };

      try {
        if (isCreate) {
          await csPlatform.sendProductCreated(productData);
        } else {
          await csPlatform.sendProductUpdated(productData);
        }
      } catch (error) {
        // Don't throw - Battle Hub notification failure shouldn't break the sync
        console.error(
          "[ProductSync] Battle Hub notification failed:",
          error instanceof Error ? error.message : error
        );
      }
    });

    // Step 5: Notify via Slack
    await step.run("notify-product-sync", async () => {
      const isCreate = event.name === "shopify/product.created";
      const action = isCreate ? "created" : "updated";
      const skus = variants
        .map((v) => v.sku)
        .filter(Boolean)
        .join(", ");
      await slack.sendOrderMessage(
        SlackChannelEnum.SHOPIFY,
        `Product ${action}: ${productTitle} (${productId})\nSKUs: ${skus || "none"}\nD365: ${d365Result.message}\nGPS: ${gpsResult.message}`,
        slack.slackNotificationId(event.id, "product-sync")
      );
    });

    const result = {
      status: "success",
      productId,
      productTitle,
      event: event.name,
      d365Result,
      gpsResult,
      processedAt: new Date().toISOString(),
    };

    console.log(`[ProductSync] ✅ Completed: ${JSON.stringify(result)}`);
    console.log(`[ProductSync] ========================================`);

    logFlowEvent({
      flow: "product_sync",
      step: "done",
      status: "completed",
      runId: _runId,
      durationMs: Date.now() - _flowStart,
      shopifyOrderId: event.data?.shopifyOrderId,
      shopifyOrderName: event.data?.shopifyOrderName,
      payload: { productId, productTitle, shopifyStore, eventName: event.name },
    });

    return result;
  }
);
