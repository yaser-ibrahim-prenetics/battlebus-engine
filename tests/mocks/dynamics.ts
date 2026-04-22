import { vi } from "vitest";

export interface MockD365State {
  orders: Map<string, any>;
  lines: any[];
  failOnCreate: boolean;
  failOnLine: boolean;
  failOnDelete: boolean;
  lineError?: string;
}

export function createMockD365State(): MockD365State {
  return {
    orders: new Map(),
    lines: [],
    failOnCreate: false,
    failOnLine: false,
    failOnDelete: false,
  };
}

let state = createMockD365State();

export function resetMockD365() {
  state = createMockD365State();
}

export function getMockD365State() {
  return state;
}

export function setMockD365Failure(
  key: keyof Pick<MockD365State, "failOnCreate" | "failOnLine" | "failOnDelete">,
  val = true
) {
  state[key] = val;
}

export function setMockD365LineError(msg: string) {
  state.lineError = msg;
  state.failOnLine = true;
}

export const mockDynamics = {
  getSalesOrderByShopifyId: vi.fn(async (shopifyRef: string, _dataAreaId?: string) => {
    if (state.orders.has(shopifyRef)) return state.orders.get(shopifyRef);
    return null;
  }),

  createSalesOrderHeaderV3: vi.fn(async (payload: any) => {
    if (state.failOnCreate) throw new Error("[D365 Mock] Header creation failed");
    const order = {
      SalesOrderNumber: `${payload.dataAreaId}-SO-${Date.now()}`,
      dataAreaId: payload.dataAreaId,
      ...payload,
    };
    state.orders.set(payload.customerOrderReference || payload.shopifyReference, order);
    return order;
  }),

  createSalesOrderLine: vi.fn(async (payload: any) => {
    if (state.failOnLine) {
      const msg = state.lineError || `[D365 Mock] Line creation failed for ${payload.itemNumber}`;
      throw new Error(msg);
    }
    const line = { InventoryLotId: `LOT-${Date.now()}`, ...payload };
    state.lines.push(line);
    return line;
  }),

  confirmSalesOrder: vi.fn(async () => ({ success: true })),
  createPrepayment: vi.fn(async () => ({ success: true })),
  deleteSalesOrderHeaderV3: vi.fn(async (dataAreaId: string, salesOrderNumber: string) => {
    if (state.failOnDelete) throw new Error("[D365 Mock] Delete failed — order may be confirmed");
    state.orders.forEach((v, k) => {
      if (v.SalesOrderNumber === salesOrderNumber) state.orders.delete(k);
    });
    return { success: true };
  }),

  createFulfilment: vi.fn(async () => ({ success: true })),
  getLotIdMap: vi.fn(async () => ({})),
};

export function setupDynamicsMock() {
  vi.doMock("@/lib/clients/dynamics", () => mockDynamics);
}
