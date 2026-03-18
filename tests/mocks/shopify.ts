import { vi } from "vitest";
import type { ShopifyOrderPayload } from "@/inngest/events";

export interface MockShopifyState {
  orders: Map<string | number, ShopifyOrderPayload>;
  metafields: Map<string | number, any[]>;
  uncancelledOrders: Set<string | number>;
  failOnUncancel: boolean;
}

export function createMockShopifyState(): MockShopifyState {
  return {
    orders: new Map(),
    metafields: new Map(),
    uncancelledOrders: new Set(),
    failOnUncancel: false,
  };
}

let state = createMockShopifyState();

export function resetMockShopify() {
  state = createMockShopifyState();
}

export function getMockShopifyState() {
  return state;
}

export function seedShopifyOrder(order: ShopifyOrderPayload) {
  state.orders.set(order.id, order);
  state.orders.set(order.name, order);
}

export function seedShopifyMetafield(orderId: string | number, metafield: any) {
  const existing = state.metafields.get(orderId) || [];
  existing.push(metafield);
  state.metafields.set(orderId, existing);
}

export const mockShopify = {
  getOrder: vi.fn(async (orderId: string | number) => {
    const order = state.orders.get(orderId);
    if (!order) throw new Error(`[Shopify Mock] Order ${orderId} not found`);
    return order;
  }),

  getOrderMetafields: vi.fn(async (orderId: string | number) => {
    return state.metafields.get(orderId) || [];
  }),

  getGpsOrderMetafield: vi.fn(async (orderId: string | number) => {
    const metafields = state.metafields.get(orderId) || [];
    const gpsMeta = metafields.find(
      (mf: any) => mf.namespace === "battle_bus" && mf.key === "gps_order"
    );
    if (!gpsMeta?.value) return null;
    try {
      return typeof gpsMeta.value === "string" ? JSON.parse(gpsMeta.value) : gpsMeta.value;
    } catch {
      return null;
    }
  }),

  setGpsOrderMetafield: vi.fn(async (orderId: string | number, data: any) => {
    const metafield = { namespace: "battle_bus", key: "gps_order", value: JSON.stringify(data) };
    const existing = state.metafields.get(orderId) || [];
    const idx = existing.findIndex(
      (mf: any) => mf.namespace === "battle_bus" && mf.key === "gps_order"
    );
    if (idx >= 0) existing[idx] = metafield;
    else existing.push(metafield);
    state.metafields.set(orderId, existing);
    return metafield;
  }),

  uncancelOrder: vi.fn(async (orderId: string | number) => {
    if (state.failOnUncancel) throw new Error("[Shopify Mock] Uncancel failed");
    state.uncancelledOrders.add(orderId);
    return { success: true };
  }),

  getOrderRisks: vi.fn(async () => []),
  getOrderTransactions: vi.fn(async () => []),
  getFulfillmentOrders: vi.fn(async () => []),
  cancelOrder: vi.fn(async () => ({ success: true })),
};

export function setupShopifyMock() {
  vi.doMock("@/lib/clients/shopify", () => mockShopify);
}
