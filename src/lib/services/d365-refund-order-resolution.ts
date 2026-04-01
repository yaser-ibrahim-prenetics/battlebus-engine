/**
 * Resolve Dynamics sales order header for refund processing: Shopify reference lookup,
 * then Supabase d365_order_number + SalesOrderNumber OData fallback.
 */
import type { D365SalesOrderHeader } from "@/lib/types/dynamics";
import * as dynamics from "@/lib/clients/dynamics";
import * as warehouseHelper from "@/lib/helpers/warehouse";
import { config } from "@/lib/config";
import { fetchD365HintByShopifyOrderId } from "./supabase-order-lookup";

export type ShopifyOrderForD365Lookup = {
  name?: string | null;
  shipping_address?: { country_code?: string | null } | null;
};

export async function resolveD365OrderHeaderForRefund(params: {
  shopifyOrderId: string;
  shopifyOrder: ShopifyOrderForD365Lookup;
}): Promise<D365SalesOrderHeader | null> {
  if (!config.features.enableDynamicsSync) {
    return null;
  }

  const { shopifyOrderId, shopifyOrder } = params;
  const country = shopifyOrder.shipping_address?.country_code || "US";
  const envArea = (config.dynamics.dataAreaId || "").toUpperCase();
  const dataAreaIds = [
    ...warehouseHelper.getSalesOrderLookupDataAreaCandidates(country),
    envArea,
    ...warehouseHelper.getConfiguredWarehouseDataAreaIds(),
  ].filter(Boolean);
  const uniqueAreas = [...new Set(dataAreaIds.map((a) => a.toUpperCase()))];

  const rawName = typeof shopifyOrder.name === "string" ? shopifyOrder.name.trim() : "";
  const stripped = rawName.replace(/^#/, "").trim();
  const refs = [...new Set([rawName, stripped].filter(Boolean))];

  for (const dataAreaId of uniqueAreas) {
    for (const ref of refs) {
      const found = await dynamics.getSalesOrderByShopifyId(ref, dataAreaId);
      if (found) {
        return found;
      }
    }
  }

  const hint = await fetchD365HintByShopifyOrderId(
    String(shopifyOrderId),
    shopifyOrder.name
  );
  if (hint?.d365OrderNumber) {
    let warehouseArea: string | null = null;
    if (hint.warehouse) {
      try {
        warehouseArea = warehouseHelper
          .getWarehouseConfig(hint.warehouse)
          .dataAreaId.toUpperCase();
      } catch {
        // Label in DB may not match warehouse-config.json key
      }
    }
    const supabaseAreaOrder = [warehouseArea, ...uniqueAreas].filter(Boolean) as string[];
    const supabaseAreas = [...new Set(supabaseAreaOrder)];

    for (const dataAreaId of supabaseAreas) {
      const found = await dynamics.getSalesOrderByNumber(hint.d365OrderNumber, dataAreaId);
      if (found) {
        console.log(
          `[Refund] Resolved D365 order via Supabase d365_order_number=${hint.d365OrderNumber} ` +
            `(dataAreaId=${found.dataAreaId || dataAreaId}); Shopify ref lookup had missed`
        );
        return found;
      }
    }
    console.warn(
      `[Refund] Supabase had d365_order_number=${hint.d365OrderNumber} but getSalesOrderByNumber ` +
        `returned no header in any tried data area — check D365 entity/SO number or dataAreaId list`
    );
  } else {
    console.warn(
      `[Refund] No Supabase row with d365_order_number for shopifyOrderId=${shopifyOrderId} ` +
        `(name=${shopifyOrder.name || "n/a"}) — set SUPABASE_* on Battle Bus or ensure Hub synced D365 #`
    );
  }

  return null;
}
