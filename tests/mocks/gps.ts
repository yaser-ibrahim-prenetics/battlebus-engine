import { vi } from "vitest";

export interface MockGpsState {
  orders: Map<string, any>;
  failOnCreate: boolean;
  failOnCancel: boolean;
  oosSkus: Set<string>;
  createError?: string;
  cancelError?: string;
}

export function createMockGpsState(): MockGpsState {
  return {
    orders: new Map(),
    failOnCreate: false,
    failOnCancel: false,
    oosSkus: new Set(),
  };
}

let state = createMockGpsState();

export function resetMockGps() {
  state = createMockGpsState();
}

export function getMockGpsState() {
  return state;
}

export function setGpsOosSkus(skus: string[]) {
  state.oosSkus = new Set(skus);
}

export function setGpsCreateFailure(error?: string) {
  state.failOnCreate = true;
  state.createError = error;
}

export function setGpsCancelFailure(error?: string) {
  state.failOnCancel = true;
  state.cancelError = error;
}

export const mockGps = {
  createOutboundOrder: vi.fn(async (payload: any, warehouse: string) => {
    if (state.oosSkus.size > 0) {
      const matchedSku = payload.productList?.find((p: any) => state.oosSkus.has(p.sku));
      if (matchedSku) {
        throw new Error(`GPS inventory error for ${payload.platformOrderNo}: ${matchedSku.sku}库存不足`);
      }
    }
    if (state.failOnCreate) {
      throw new Error(state.createError || `GPS order failed: ${payload.platformOrderNo}`);
    }
    const orderNo = `GPS-${Date.now()}`;
    state.orders.set(orderNo, { ...payload, warehouse });
    return {
      success: true,
      response: { data: [{ orderNo }] },
    };
  }),

  cancelOutboundOrder: vi.fn(async (orderNumber: string, _warehouse: string) => {
    if (state.failOnCancel) {
      return {
        success: false,
        message: state.cancelError || "Order already shipped or not found",
      };
    }
    state.orders.delete(orderNumber);
    return { success: true, message: "Cancelled" };
  }),

  isGpsInventoryError: vi.fn((msg: string) => {
    const m = (msg || "").toLowerCase();
    return m.includes("库存不足") || m.includes("inventory") || m.includes("out_of_stock");
  }),

  classifyGpsError: vi.fn((msg: string) => {
    if (mockGps.isGpsInventoryError(msg)) return "out_of_stock";
    if (msg.includes("未维护新品")) return "unmaintained_product";
    return "gps_error";
  }),
};

export function setupGpsMock() {
  vi.doMock("@/lib/clients/gps", () => mockGps);
}
