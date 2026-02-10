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
import { SlackChannelEnum } from "@/lib/types/slack";
import { RETRY_CONFIGS } from "@/lib/utils/constants";

export const processProductSync = inngest.createFunction(
  {
    id: "process-product-sync",
    name: "Process Shopify Product Sync",
    retries: RETRY_CONFIGS.DEFAULT,
    concurrency: [{ limit: 5 }],
  },
  [
    { event: "shopify/product.created" },
    { event: "shopify/product.updated" },
    { event: "shopify/product.deleted" },
  ],
  async ({ event, step }: { event: any; step: any }) => {
    const { productId, productTitle, shopifyStore, productJson } = event.data;
    const product = productJson as ShopifyProductPayload;

    console.log(`[ProductSync] ========================================`);
    console.log(`[ProductSync] Processing product: ${productTitle} (${productId}) from ${shopifyStore}`);
    console.log(`[ProductSync] Event: ${event.name}`);
    
    // Handle deletion
    if (event.name === "shopify/product.deleted") {
      console.log(`[ProductSync] Product deletion detected - syncing to D365 and GPS`);
      
      // Step 1: Delete from D365
      const d365Result = await step.run("delete-product-from-d365", async () => {
        console.log(`[ProductSync] Deleting product from D365...`);
        // TODO: Implement actual D365 product deletion
        return {
          success: true,
          message: "Placeholder - D365 product deletion not yet implemented",
        };
      });

      // Step 2: Delete from GPS
      const gpsResult = await step.run("delete-product-from-gps", async () => {
        console.log(`[ProductSync] Deleting product from GPS...`);
        // TODO: Implement actual GPS product deletion
        return {
          success: true,
          message: "Placeholder - GPS product deletion not yet implemented",
        };
      });

      // Step 3: Notify Battle Hub
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

      return {
        status: "deleted",
        productId,
        productTitle,
        d365Result,
        gpsResult,
        processedAt: new Date().toISOString(),
      };
    }

    console.log(`[ProductSync] Status: ${product.status}`);
    console.log(`[ProductSync] Vendor: ${product.vendor}`);
    console.log(`[ProductSync] Type: ${product.product_type}`);
    console.log(`[ProductSync] Tags: ${product.tags}`);
    console.log(`[ProductSync] Variants: ${product.variants?.length || 0}`);

    // Extract variant data for syncing
    const variants = (product.variants || []).map((v) => ({
      sku: v.sku,
      price: v.price,
      barcode: v.barcode,
      weight: v.weight,
      weight_unit: v.weight_unit,
      inventory_quantity: v.inventory_quantity,
    }));

    console.log(`[ProductSync] Extracted ${variants.length} variants`);
    console.log(`[ProductSync] Variants with SKUs: ${variants.filter((v) => v.sku && v.sku.trim()).length}`);
    console.log(`[ProductSync] SKUs: ${variants.map((v) => v.sku).filter(Boolean).join(", ") || "none"}`);
    
    // Log variant details for debugging
    variants.forEach((v, idx) => {
      console.log(`[ProductSync]   Variant ${idx + 1}: SKU="${v.sku || "MISSING"}", Price=${v.price || "N/A"}, Barcode=${v.barcode || "N/A"}`);
    });

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

    // Step 3: Notify Battle Hub (always send, even if D365/GPS sync failed)
    await step.run("notify-battle-hub-product-sync", async () => {
      console.log(`[ProductSync] Notifying Battle Hub...`);
      console.log(`[ProductSync] Variants count: ${variants.length}`);
      console.log(`[ProductSync] Variants with SKUs: ${variants.filter((v) => v.sku && v.sku.trim()).length}`);
      
      const isCreate = event.name === "shopify/product.created";
      // Map variants to convert null to undefined for barcode (TypeScript type compatibility)
      const mappedVariants = variants.map((v) => ({
        sku: v.sku,
        price: v.price,
        barcode: v.barcode ?? undefined, // Convert null to undefined
        weight: v.weight,
        weight_unit: v.weight_unit,
        inventory_quantity: v.inventory_quantity,
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
          console.log(`[ProductSync] Sending product.created event to Battle Hub...`);
          await csPlatform.sendProductCreated(productData);
          console.log(`[ProductSync] ✅ Successfully sent product.created to Battle Hub`);
        } else {
          console.log(`[ProductSync] Sending product.updated event to Battle Hub...`);
          await csPlatform.sendProductUpdated(productData);
          console.log(`[ProductSync] ✅ Successfully sent product.updated to Battle Hub`);
        }
      } catch (error) {
        console.error(`[ProductSync] ❌ Failed to send product event to Battle Hub:`, error);
        // Don't throw - Battle Hub notification failure shouldn't break the sync
      }
    });

    // Step 4: Notify via Slack
    await step.run("notify-product-sync", async () => {
      const isCreate = event.name === "shopify/product.created";
      const action = isCreate ? "created" : "updated";
      const skus = variants.map((v) => v.sku).filter(Boolean).join(", ");
      await slack.sendOrderMessage(
        SlackChannelEnum.SHOPIFY,
        `Product ${action}: ${productTitle} (${productId})\nSKUs: ${skus || "none"}\nD365: ${d365Result.message}\nGPS: ${gpsResult.message}`
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

    return result;
  }
);

