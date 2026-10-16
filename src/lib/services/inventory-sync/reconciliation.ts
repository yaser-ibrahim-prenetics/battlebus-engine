import { queryD365Inventory } from "./d365-inventory";
import { syncD365ToShopify } from "./d365-to-shopify";
import { queryGpsInventory, queryGpsWarehouseInventory } from "./gps-inventory";
import { syncGpsToD365 } from "./gps-to-d365";
import { queryShopifyInventory } from "./shopify-inventory";
import type { InventoryDiff, ReconciliationResult } from "./types";

/** Calculate inventory discrepancies across GPS, D365, and Shopify. */
export async function calculateDiscrepancies(
  skus: string[],
  warehouseName?: string
): Promise<InventoryDiff[]> {
  console.log(`[InventorySync] Calculating discrepancies for ${skus.length} SKUs`);

  const [gpsInventory, d365Inventory, shopifyInventory] = await Promise.all([
    warehouseName ? queryGpsWarehouseInventory(warehouseName, skus) : queryGpsInventory(skus),
    queryD365Inventory(skus),
    queryShopifyInventory(skus),
  ]);

  const diffs = skus.map((sku): InventoryDiff => {
    const gpsLevel = gpsInventory.get(sku)?.available ?? null;
    const d365Level = d365Inventory.get(sku)?.available ?? null;
    const shopifyLevel = shopifyInventory.get(sku)?.available ?? null;
    const gpsToD365Diff = gpsLevel !== null && d365Level !== null ? gpsLevel - d365Level : null;
    const d365ToShopifyDiff =
      d365Level !== null && shopifyLevel !== null ? d365Level - shopifyLevel : null;
    const needsSync =
      (gpsToD365Diff !== null && gpsToD365Diff !== 0) ||
      (d365ToShopifyDiff !== null && d365ToShopifyDiff !== 0);

    return {
      sku,
      gpsLevel,
      d365Level,
      shopifyLevel,
      gpsToD365Diff,
      d365ToShopifyDiff,
      needsSync,
    };
  });

  console.log(
    `[InventorySync] Found ${diffs.filter((diff) => diff.needsSync).length} discrepancies out of ${skus.length} SKUs`
  );
  return diffs;
}

/** Reconcile inventory and optionally repair discrepancies in dependency order. */
export async function runReconciliation(
  skus: string[],
  warehouseName?: string,
  autoSync: boolean = false
): Promise<ReconciliationResult> {
  console.log(
    `[InventorySync] Running reconciliation for ${skus.length} SKUs (autoSync=${autoSync})`
  );

  const result: ReconciliationResult = {
    timestamp: new Date(),
    skusChecked: skus.length,
    discrepanciesFound: 0,
    syncActions: [],
    errors: [],
  };

  try {
    const diffs = await calculateDiscrepancies(skus, warehouseName);
    const discrepancies = diffs.filter((diff) => diff.needsSync);
    result.discrepanciesFound = discrepancies.length;

    if (!autoSync) {
      console.log("[InventorySync] Auto-sync disabled, returning discrepancies only");
      return result;
    }

    for (const diff of discrepancies) {
      if (diff.gpsToD365Diff !== null && diff.gpsToD365Diff !== 0) {
        const syncResult = await syncGpsToD365(diff.sku, warehouseName || "GPS Warehouse");
        result.syncActions.push(syncResult);

        if (!syncResult.success && syncResult.error) {
          result.errors.push(`GPS->D365: ${syncResult.error}`);
        }
      }

      if (diff.d365ToShopifyDiff !== null && diff.d365ToShopifyDiff !== 0) {
        const syncResult = await syncD365ToShopify(diff.sku);
        result.syncActions.push(syncResult);

        if (!syncResult.success && syncResult.error) {
          result.errors.push(`D365->Shopify: ${syncResult.error}`);
        }
      }
    }

    console.log(
      `[InventorySync] Reconciliation complete: ${result.syncActions.length} actions, ${result.errors.length} errors`
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    result.errors.push(`Reconciliation failed: ${errorMessage}`);
    console.error(`[InventorySync] Reconciliation error: ${errorMessage}`);
  }

  return result;
}
