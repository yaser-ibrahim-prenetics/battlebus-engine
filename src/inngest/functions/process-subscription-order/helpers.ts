import type { ShopifyOrderPayload } from "../../events";

export function selectPreferredFulfillmentLocationId(fulfillmentOrders: any[]): number | null {
  const activeOrders = fulfillmentOrders.filter(
    (order: any) => order?.status === "open" || order?.status === "in_progress"
  );
  if (!activeOrders.length) return null;

  const deliverable = activeOrders.filter((order: any) => {
    const methodType = String(order?.delivery_method?.method_type || "").toLowerCase();
    const locationName = String(order?.assigned_location?.name || "").toLowerCase();
    return methodType !== "none" && !locationName.includes("virtual");
  });
  if (deliverable[0]?.assigned_location_id) return Number(deliverable[0].assigned_location_id);

  const nonVirtual = activeOrders.filter(
    (order: any) =>
      !String(order?.assigned_location?.name || "")
        .toLowerCase()
        .includes("virtual")
  );
  return nonVirtual[0]?.assigned_location_id ? Number(nonVirtual[0].assigned_location_id) : null;
}

export function getIntendedLocationIdFromOrder(order: ShopifyOrderPayload): number | null {
  const attributes = Array.isArray((order as any)?.note_attributes)
    ? ((order as any).note_attributes as Array<{ name?: string; value?: string }>)
    : [];
  const getAttribute = (key: string) =>
    attributes.find((attribute) => String(attribute?.name || "").toLowerCase() === key)?.value ||
    "";

  const intendedName = getAttribute("intended_location_name");
  if (intendedName && intendedName.toLowerCase().includes("virtual")) return null;

  const intendedId = Number(String(getAttribute("intended_location_id")).trim());
  return Number.isFinite(intendedId) && intendedId > 0 ? intendedId : null;
}

export function isNonRetryableOrderError(message: string): boolean {
  const normalized = String(message || "").toLowerCase();
  return (
    normalized.includes("out of stock") ||
    normalized.includes("inventory insufficient") ||
    normalized.includes("cannot be reserved") ||
    (normalized.includes("item number") && normalized.includes("does not exist")) ||
    normalized.includes("sku有误") ||
    normalized.includes("未维护新品") ||
    normalized.includes("未通过审核") ||
    normalized.includes("unknown warehouse") ||
    normalized.includes("unsupported warehouse") ||
    normalized.includes("unsupported virtual warehouse") ||
    normalized.includes("not fully configured in battle hub")
  );
}

export function isServiceSkuItemNumber(itemNumber?: string | null): boolean {
  const sku = String(itemNumber || "").toUpperCase();
  return sku.startsWith("IM8-SER-") || sku.startsWith("PRE-SER-");
}

export function isD365ItemNotFoundError(message: string): boolean {
  const normalized = String(message || "").toLowerCase();
  return normalized.includes("item number") && normalized.includes("does not exist");
}

export function isRefillOrder(order: ShopifyOrderPayload): boolean {
  const tags = (order.tags || "")
    .toLowerCase()
    .split(",")
    .map((tag) => tag.trim());
  const hasRefillTag = tags.some(
    (tag) => tag.includes("refill") || tag.includes("renewal") || tag.includes("subscription order")
  );
  const hasRefillSku = order.line_items.some(
    (item) => item.sku && !item.gift_card && item.requires_shipping
  );
  return hasRefillSku && !hasRefillTag;
}

export function extractSubscriptionContractId(order: ShopifyOrderPayload): string {
  const attributes = order.note_attributes || [];
  return (
    attributes.find(
      (attribute) => attribute.name === "subscription_id" || attribute.name === "contract_id"
    )?.value || ""
  );
}
