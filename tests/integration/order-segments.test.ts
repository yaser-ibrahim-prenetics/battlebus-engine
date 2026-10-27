import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { loadFixture } from "../fixtures";
const mocks = vi.hoisted(() => ({
  pool: vi.fn(),
  query: vi.fn(),
  graphql: vi.fn(),
  fos: vi.fn(),
  header: vi.fn(),
  line: vi.fn(),
  confirm: vi.fn(),
  prepay: vi.fn(),
  gps: vi.fn(),
  hub: vi.fn(),
}));
vi.mock("@/lib/db/database", () => ({ getDatabasePool: mocks.pool, queryDatabase: mocks.query }));
vi.mock("@/lib/clients/shopify", () => ({
  shopifyAdminGraphql: mocks.graphql,
  getFulfillmentOrders: mocks.fos,
  resolveShopifyAdminCredentials: () => ({ shopDomain: "segments-test.myshopify.com" }),
}));
vi.mock("@/lib/clients/dynamics", () => ({
  getSalesOrderByShopifyId: vi.fn(async () => null),
  createSalesOrderHeaderV3: mocks.header,
  createSalesOrderLine: mocks.line,
  confirmSalesOrder: mocks.confirm,
  createPrepayment: mocks.prepay,
}));
vi.mock("@/lib/clients/gps", () => ({ createOutboundOrder: mocks.gps }));
vi.mock("@/lib/clients/cs-platform", () => ({ sendOrderCreated: mocks.hub }));
vi.mock("@/lib/services/location-routing", () => ({
  getWarehouseNameForLocation: vi.fn(async () => "GPS Warehouse"),
  getDataAreaIdForLocationAndCountry: vi.fn(async () => "H007"),
}));
import { processOrderSegments } from "@/lib/services/order-segments/process";
import {
  executeFulfillmentAction,
  ConfirmedActionFailure,
} from "@/lib/services/fulfillment-actions/ledger";
import { readPlan } from "@/lib/services/order-segments/store";
import { reserveAllocations } from "@/lib/services/order-segments/allocation";
const shop = "segments-test.myshopify.com";
const orderId = "987000001";
const step = { run: async <T>(_id: string, fn: () => Promise<T>) => fn() };

describe.skipIf(!process.env.FULFILLMENT_TEST_DATABASE_URL)(
  "durable order segments with PostgreSQL",
  () => {
    let pool: Pool;
    let order: ReturnType<typeof loadFixture>;
    let nodes: Map<string, number>;
    let sequence: number;
    let gpsPosts: string[];
    let rejectSecondGps: boolean;
    const fo = (id: string, quantity: number) => ({
      id: `gid://shopify/FulfillmentOrder/${id}`,
      lineItems: {
        nodes: [
          {
            id: `gid://shopify/FulfillmentOrderLineItem/${id}`,
            remainingQuantity: quantity,
            lineItem: { id: "gid://shopify/LineItem/11" },
          },
        ],
        pageInfo: { hasNextPage: false },
      },
    });
    const clean = async () => {
      await pool.query("DELETE FROM public.order_segment_fulfillments WHERE shop_domain=$1", [
        shop,
      ]);
      await pool.query("DELETE FROM public.order_segment_plans WHERE shop_domain=$1", [shop]);
      await pool.query("DELETE FROM public.fulfillment_action_aliases WHERE scope LIKE $1", [
        `%${shop}%`,
      ]);
      await pool.query("DELETE FROM public.fulfillment_actions WHERE scope LIKE $1", [`%${shop}%`]);
    };
    beforeAll(() => {
      pool = new Pool({ connectionString: process.env.FULFILLMENT_TEST_DATABASE_URL });
      mocks.pool.mockResolvedValue(pool);
      mocks.query.mockImplementation((sql, values) => pool.query(sql, values));
    });
    beforeEach(async () => {
      await clean();
      vi.clearAllMocks();
      nodes = new Map([["51", 5]]);
      sequence = 51;
      gpsPosts = [];
      rejectSecondGps = false;
      order = loadFixture("multiLineOrder");
      order.id = Number(orderId);
      order.name = "#SEGMENT-TEST";
      order.total_price = "500.00";
      order.shipping_address.country_code = "GB";
      order.line_items = [
        {
          ...order.line_items[0],
          id: 11,
          requires_shipping: true,
          gift_card: false,
          quantity: 5,
          price: "100.00",
          total_discount: "10.01",
        },
      ];
      mocks.fos.mockResolvedValue([
        {
          id: 51,
          assigned_location_id: 71,
          status: "open",
          line_items: [{ id: 81, line_item_id: 11, fulfillable_quantity: 5, quantity: 5 }],
        },
      ]);
      mocks.graphql.mockImplementation(async (_query, vars) => {
        if (vars.id) {
          const id = vars.id.split("/").pop();
          return { data: { fulfillmentOrder: fo(id, nodes.get(id)!) } };
        }
        const input = vars.splits[0];
        const id = input.fulfillmentOrderId.split("/").pop();
        const quantity = input.fulfillmentOrderLineItems[0].quantity;
        const newId = String(++sequence);
        nodes.set(id, nodes.get(id)! - quantity);
        nodes.set(newId, quantity);
        return {
          data: {
            fulfillmentOrderSplit: {
              userErrors: [],
              fulfillmentOrderSplits: [
                {
                  fulfillmentOrder: fo(id, nodes.get(id)!),
                  remainingFulfillmentOrder: fo(newId, quantity),
                },
              ],
            },
          },
        };
      });
      let headers = 0,
        lines = 0;
      mocks.header.mockImplementation(async () => ({ SalesOrderNumber: `SO-${++headers}` }));
      mocks.line.mockImplementation(async () => ({ InventoryLotId: `LOT-${++lines}` }));
      mocks.confirm.mockResolvedValue({});
      mocks.prepay.mockResolvedValue({});
      mocks.gps.mockImplementation(async (payload) =>
        executeFulfillmentAction(
          {
            provider: "gps",
            scope: shop,
            sourceOrderId: payload.platformOrderNo,
            sourceLineIds: ["sku"],
            action: "create",
          },
          payload,
          async () => {
            if (rejectSecondGps && payload.platformOrderNo.endsWith("-1"))
              throw new ConfirmedActionFailure("inventory unavailable");
            gpsPosts.push(payload.platformOrderNo);
            return { response: { data: [{ orderNo: `GPS-${payload.platformOrderNo}` }] } };
          }
        )
      );
    });
    afterAll(async () => {
      if (pool) {
        await clean();
        await pool.end();
      }
    });
    const run = () =>
      processOrderSegments({
        order,
        step,
        shopDomain: shop,
        fallbackDataArea: "H007",
        accounting: {
          paymentId: "actual-payment",
          giftCardApplications: [],
          purchasedGiftCards: {},
        },
      });

    it("creates separate provider orders, conserves quantity, and survives a fresh replay", async () => {
      const result = await run();
      expect(result?.segments).toHaveLength(3);
      expect(mocks.header).toHaveBeenCalledTimes(3);
      expect(mocks.graphql).toHaveBeenCalledTimes(4);
      expect(gpsPosts).toEqual(["#SEGMENT-TEST", "#SEGMENT-TEST-1", "#SEGMENT-TEST-2"]);
      const quantities = mocks.gps.mock.calls.map(([payload]) => payload.productList[0].quantity);
      expect(quantities).toEqual([2, 2, 1]);
      expect(
        mocks.header.mock.calls.every(([header]) => header.paymentId === "actual-payment")
      ).toBe(true);
      const stored = await readPlan(shop, orderId);
      expect(Object.values(stored!.progress).map((p) => p.fulfillmentOrderId)).toEqual([
        "52",
        "53",
        "51",
      ]);
      await run();
      expect(mocks.header).toHaveBeenCalledTimes(3);
      expect(mocks.graphql).toHaveBeenCalledTimes(4);
      expect(gpsPosts).toHaveLength(3);
      expect(mocks.prepay).toHaveBeenCalledTimes(3);
    });

    it("resumes only unfinished work after a rejected second shipment", async () => {
      rejectSecondGps = true;
      await expect(run()).rejects.toThrow("inventory unavailable");
      expect(gpsPosts).toEqual(["#SEGMENT-TEST"]);
      rejectSecondGps = false;
      order.line_items[0].fulfillment_status = "fulfilled"; // volatile Shopify state must not regroup the plan
      await run();
      expect(mocks.header).toHaveBeenCalledTimes(3);
      expect(gpsPosts).toEqual(["#SEGMENT-TEST", "#SEGMENT-TEST-1", "#SEGMENT-TEST-2"]);
    });

    it("blocks ambiguous Shopify mutation outcomes before finance", async () => {
      mocks.graphql.mockImplementation(async (_query, vars) => {
        if (vars.id) return { data: { fulfillmentOrder: fo("51", 5) } };
        throw new Error("timeout after acceptance");
      });
      await expect(run()).rejects.toThrow("requires reconciliation");
      await expect(run()).rejects.toThrow("requires reconciliation");
      expect(mocks.graphql).toHaveBeenCalledTimes(2);
      expect(mocks.header).not.toHaveBeenCalled();
      expect(mocks.gps).not.toHaveBeenCalled();
    });

    it("serializes competing shipment allocations and reserves service lines once", async () => {
      await run();
      const stored = (await readPlan(shop, orderId))!;
      const allocations = await Promise.allSettled([
        reserveAllocations(shop, stored, "a", ["52"], { "11": 2 }),
        reserveAllocations(shop, stored, "b", ["52"], { "11": 2 }),
      ]);
      expect(allocations.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(allocations.filter((result) => result.status === "rejected")).toHaveLength(1);
    });
  }
);
