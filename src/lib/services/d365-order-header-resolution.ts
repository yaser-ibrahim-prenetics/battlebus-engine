/**
 * Shared Dynamics sales order header resolution for refund, fulfillment, and similar flows.
 * Order of attempt:
 * 1) Supabase `orders` row (Shopify **name** first, then numeric id) → `d365_order_number` → OData by SalesOrderNumber
 * 2) OData `SalesOrderHeadersV3` by `THK_ShopifyReference` (name variants) across candidate data areas
 */
import type { D365SalesOrderHeader } from "@/lib/types/dynamics";
import * as dynamics from "@/lib/clients/dynamics";
import * as warehouseHelper from "@/lib/helpers/warehouse";
import { config } from "@/lib/config";
import { fetchD365HintByShopifyOrderId } from "./supabase-order-lookup";

export type ResolveD365OrderHeaderInput = {
  shopifyOrderId: string;
  shopifyOrderName: string | null | undefined;
  /** Drives data-area candidate list; defaults to US */
  shippingCountryCode?: string | null;
  /** e.g. STORD/HK location mapping — tried early for getSalesOrderByNumber */
  preferredDataAreaId?: string | null;
};

export async function resolveD365OrderHeaderForLifecycle(
  input: ResolveD365OrderHeaderInput
): Promise<D365SalesOrderHeader | null> {
  if (!config.features.enableDynamicsSync) {
    return null;
  }

  const country = input.shippingCountryCode || "US";
  const envArea = (config.dynamics.dataAreaId || "").toUpperCase();
  const pref = input.preferredDataAreaId
    ? String(input.preferredDataAreaId).toUpperCase().trim()
    : "";

  const dataAreaIds = [
    ...(pref ? [pref] : []),
    ...warehouseHelper.getSalesOrderLookupDataAreaCandidates(country),
    envArea,
    ...warehouseHelper.getConfiguredWarehouseDataAreaIds(),
  ].filter(Boolean);
  const uniqueAreas = [...new Set(dataAreaIds.map((a) => String(a).toUpperCase()))];

  const rawName =
    typeof input.shopifyOrderName === "string" ? input.shopifyOrderName.trim() : "";
  const stripped = rawName.replace(/^#/, "").trim();
  const refs = [...new Set([rawName, stripped].filter(Boolean))];

  const hint = await fetchD365HintByShopifyOrderId(
    String(input.shopifyOrderId),
    input.shopifyOrderName
  );

  if (hint?.d365OrderNumber) {
    let warehouseArea: string | null = null;
    if (hint.warehouse) {
      try {
        warehouseArea = warehouseHelper
          .getWarehouseConfig(hint.warehouse)
          .dataAreaId.toUpperCase();
      } catch {
        /* DB label may not match warehouse-config.json */
      }
    }
    const byNumberAreas = [
      warehouseArea,
      pref || null,
      ...uniqueAreas,
    ].filter(Boolean) as string[];
    const salesOrderAreas = [...new Set(byNumberAreas)];

    for (const dataAreaId of salesOrderAreas) {
      const found = await dynamics.getSalesOrderByNumber(hint.d365OrderNumber, dataAreaId);
      if (found) {
        console.log(
          `[D365Resolve] Header via Supabase d365_order_number=${hint.d365OrderNumber} ` +
            `(dataAreaId=${found.dataAreaId || dataAreaId})`
        );
        return found;
      }
    }
    console.warn(
      `[D365Resolve] Supabase d365_order_number=${hint.d365OrderNumber} but getSalesOrderByNumber ` +
        `missed in all tried data areas`
    );
  } else if (String(input.shopifyOrderId || "").trim()) {
    console.warn(
      `[D365Resolve] No Supabase row with d365_order_number for shopifyOrderId=${input.shopifyOrderId} ` +
        `name=${input.shopifyOrderName || "n/a"} — falling back to THK_ShopifyReference OData`
    );
  }

  for (const dataAreaId of uniqueAreas) {
    for (const ref of refs) {
      const found = await dynamics.getSalesOrderByShopifyId(ref, dataAreaId);
      if (found) {
        return found;
      }
    }
  }

  return null;
}
