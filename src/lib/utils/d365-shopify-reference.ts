/**
 * Parse D365 OData write errors when THK_ShopifyReference is already assigned.
 *
 * Example infolog:
 *   The shopify reference IM8-22037 is already exist in sales order H007-SO-123916.
 */
export function parseDuplicateShopifyReferenceSalesOrderNumber(
  errorText: string
): string | null {
  const text = String(errorText || "");
  const match = text.match(
    /shopify reference .+? is already exist in sales order ([A-Za-z0-9-]+)/i
  );
  const salesOrderNumber = match?.[1]?.trim();
  return salesOrderNumber || null;
}

/** Normalize Shopify order name / THK reference candidates for OData lookup. */
export function shopifyReferenceLookupCandidates(
  shopifyOrderName: string | null | undefined,
  shopifyOrderId?: string | null
): string[] {
  const rawName = typeof shopifyOrderName === "string" ? shopifyOrderName.trim() : "";
  const stripped = rawName.replace(/^#/, "").trim();
  const idStr = shopifyOrderId ? String(shopifyOrderId).trim() : "";
  return [
    ...new Set(
      [rawName, stripped, stripped ? `#${stripped}` : "", idStr].filter(
        (x): x is string => typeof x === "string" && x.length > 0
      )
    ),
  ];
}
