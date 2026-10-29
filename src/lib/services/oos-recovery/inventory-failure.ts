import type { ShopifyOrderPayload } from "@/inngest/events";
import {
  createShopifyToDynamicsLineTransformer,
  explodeBundleLines,
  filterDummySkus,
  filterServiceSkus,
} from "@/lib/transformers/sku";
import { ConfirmedActionFailure } from "@/lib/services/fulfillment-actions/ledger";

export type InventoryProvider = "gps" | "d365";
export type InventoryFailureCategory =
  | "out_of_stock"
  | "inventory_insufficient"
  | "item_not_found"
  | "unmaintained_product";

export type ProviderBlockedItem = {
  provider: InventoryProvider;
  warehouse: string;
  sku: string;
  orderLineId: string;
  quantityNeeded: number;
};

export const MAX_OOS_BLOCKED_ITEMS = 500;
export const OOS_BLOCKED_ITEM_MAX_BYTES = {
  warehouse: 128,
  sku: 256,
  orderLineId: 256,
} as const;

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function assertProviderBlockedItemsPersistable(items: ProviderBlockedItem[]): void {
  if (items.length > MAX_OOS_BLOCKED_ITEMS) {
    throw new Error(`OOS mutation failure exceeds ${MAX_OOS_BLOCKED_ITEMS} blocked items`);
  }
  for (const item of items) {
    if (
      !item.warehouse.trim() ||
      !item.sku.trim() ||
      !item.orderLineId.trim() ||
      !Number.isSafeInteger(item.quantityNeeded) ||
      item.quantityNeeded <= 0
    ) {
      throw new Error("OOS mutation failure contains an invalid blocked item");
    }
    for (const [field, limit] of Object.entries(OOS_BLOCKED_ITEM_MAX_BYTES)) {
      if (utf8Length(item[field as keyof typeof OOS_BLOCKED_ITEM_MAX_BYTES]) > limit) {
        throw new Error(`OOS mutation failure ${field} exceeds ${limit} UTF-8 bytes`);
      }
    }
  }
}

export type InventoryDependency = ProviderBlockedItem & {
  shopifyOrderId: string;
  shopifyOrderName: string;
  shopifyStore: string;
  safeFailureCategory: InventoryFailureCategory;
};

/** A provider-confirmed inventory rejection with structured, non-customer dependency keys. */
export class InventoryUnavailableError extends ConfirmedActionFailure {
  constructor(
    public readonly provider: InventoryProvider,
    public readonly category: InventoryFailureCategory,
    message: string,
    public readonly blockedItems: ProviderBlockedItem[] = [],
    public readonly providerOrderNumber?: string,
    public readonly providerWarehouse?: string
  ) {
    super(message);
    this.name = "InventoryUnavailableError";
  }
}

export function isInventoryUnavailableError(error: unknown): error is InventoryUnavailableError {
  const candidate = error as Partial<InventoryUnavailableError> | undefined;
  return (
    (error instanceof InventoryUnavailableError ||
      candidate?.name === "InventoryUnavailableError") &&
    (candidate?.provider === "gps" || candidate?.provider === "d365") &&
    typeof candidate?.category === "string" &&
    Array.isArray(candidate?.blockedItems)
  );
}

export function classifyD365InventoryFailure(message: string): InventoryFailureCategory | null {
  const normalized = message.toLowerCase();
  if (/does not exist|not found|released product|item number.*invalid/.test(normalized)) {
    return "item_not_found";
  }
  if (
    /cannot be reserved|inventory.*insufficient|insufficient.*inventory|out of stock/.test(
      normalized
    )
  ) {
    return "inventory_insufficient";
  }
  return null;
}

/**
 * Preserve each original Shopify line while applying the exact provider SKU expansion used by
 * GPS/D365. Duplicate SKUs remain separate dependencies even though GPS merges its API payload.
 */
export function buildProviderBlockedItems(params: {
  order: ShopifyOrderPayload;
  provider: InventoryProvider;
  warehouse: string;
}): ProviderBlockedItem[] {
  const transformSku = createShopifyToDynamicsLineTransformer();
  return params.order.line_items.flatMap((line) => {
    if (!line.requires_shipping || line.gift_card || !line.sku?.trim()) return [];
    const expanded = filterDummySkus(
      filterServiceSkus(
        explodeBundleLines([transformSku({ itemNumber: line.sku.trim(), quantity: line.quantity })])
      )
    );
    return expanded.map((item) => ({
      provider: params.provider,
      warehouse: params.warehouse.trim().toUpperCase(),
      sku: item.itemNumber.trim().toUpperCase(),
      orderLineId: String(line.id),
      quantityNeeded: item.quantity,
    }));
  });
}

export function toInventoryDependencies(params: {
  error: InventoryUnavailableError;
  order: ShopifyOrderPayload;
  shopifyStore: string;
  warehouse: string;
}): InventoryDependency[] {
  const blockedItems = params.error.blockedItems.length
    ? params.error.blockedItems
    : buildProviderBlockedItems({
        order: params.order,
        provider: params.error.provider,
        warehouse: params.warehouse,
      });
  const canonicalStore = params.shopifyStore.trim().toLowerCase();
  return blockedItems.map((item) => ({
    ...item,
    warehouse: item.warehouse.trim().toUpperCase(),
    sku: item.sku.trim().toUpperCase(),
    shopifyOrderId: String(params.order.id),
    shopifyOrderName: params.order.name,
    shopifyStore: canonicalStore,
    safeFailureCategory: params.error.category,
  }));
}
