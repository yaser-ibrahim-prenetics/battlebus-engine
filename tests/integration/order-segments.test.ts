import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { loadFixture } from "../fixtures";
vi.mock("@/lib/services/flow-logs", () => ({ logFlowEventSync: vi.fn() }));
vi.mock("@/inngest/client", () => ({ inngest: { send: vi.fn() } }));
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
  cancel: vi.fn(),
  area: vi.fn(),
  hub: vi.fn(),
  fulfill: vi.fn(),
  transport: vi.fn(),
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
  createFulfilment: mocks.fulfill,
  verifyDepositFulfillmentApplied: vi.fn(async () => ({})),
}));
vi.mock("@/lib/clients/gps", () => ({
  createOutboundOrder: mocks.gps,
  cancelOutboundOrder: mocks.cancel,
}));
vi.mock("@/lib/clients/cs-platform", () => ({
  sendOrderCreated: mocks.hub,
  sendOrderUpdate: mocks.hub,
}));
vi.mock("@/lib/services/location-routing", () => ({
  resolveStordEuOverrideForMappedLocation: vi.fn(async () => null),
  resolveStordHubWhenFulfillmentLocationUnmapped: vi.fn(async () => null),
  getWarehouseNameForLocation: vi.fn(async () => "GPS Warehouse"),
  getDataAreaIdForLocationAndCountry: mocks.area,
}));
import { processOrderSegments } from "@/lib/services/order-segments/process";
import {
  executeFulfillmentAction,
  ConfirmedActionFailure,
} from "@/lib/services/fulfillment-actions/ledger";
import { cancelOrderSegments } from "@/lib/services/order-segments/cancellation";
import { publishSegmentCompletion } from "@/lib/services/order-segments/completion";
import { fulfillOrderSegments } from "@/lib/services/order-segments/fulfillment";
import { postDurableFulfilment } from "@/lib/clients/dynamics/fulfillment";
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
      await pool.query(
        "DELETE FROM public.fulfillment_action_aliases WHERE source_order_id LIKE 'SEG-TEST-SO-%'"
      );
      await pool.query(
        "DELETE FROM public.fulfillment_actions WHERE source_order_id LIKE 'SEG-TEST-SO-%'"
      );
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
      mocks.query.mockImplementation((sql, values) => pool.query(sql, values));
      mocks.hub.mockResolvedValue(undefined);
      mocks.area.mockResolvedValue("H007");
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
        if (_query.includes("query FulfillmentSegments"))
          return {
            data: {
              fulfillment: {
                fulfillmentOrders: {
                  nodes: [{ id: "gid://shopify/FulfillmentOrder/52" }],
                  pageInfo: { hasNextPage: false },
                },
              },
            },
          };
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
      mocks.header.mockImplementation(async () => ({
        SalesOrderNumber: `SEG-TEST-SO-${++headers}`,
      }));
      mocks.line.mockImplementation(async () => ({ InventoryLotId: `LOT-${++lines}` }));
      mocks.transport.mockImplementation(async () =>
        Response.json({ status: 1, Message: "ok", Result: "PS", $id: "1" })
      );
      mocks.fulfill.mockImplementation((req) =>
        postDurableFulfilment(req, { authenticate: async () => "test", fetch: mocks.transport })
      );
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
      expect([...gpsPosts].sort()).toEqual(["#SEGMENT-TEST", "#SEGMENT-TEST-1", "#SEGMENT-TEST-2"]);
      const quantities = [...mocks.gps.mock.calls]
        .sort(([a], [b]) => a.platformOrderNo.localeCompare(b.platformOrderNo))
        .map(([payload]) => payload.productList[0].quantity);
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
      expect([...gpsPosts].sort()).toEqual(["#SEGMENT-TEST", "#SEGMENT-TEST-2"]);
      rejectSecondGps = false;
      order.line_items[0].fulfillment_status = "fulfilled"; // volatile Shopify state must not regroup the plan
      await run();
      expect(mocks.header).toHaveBeenCalledTimes(3);
      expect([...gpsPosts].sort()).toEqual(["#SEGMENT-TEST", "#SEGMENT-TEST-1", "#SEGMENT-TEST-2"]);
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
        reserveAllocations(shop, stored, "a", ["52"], { "11": 2 }, "2026-10-27"),
        reserveAllocations(shop, stored, "b", ["52"], { "11": 2 }, "2026-10-27"),
      ]);
      expect(allocations.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(allocations.filter((result) => result.status === "rejected")).toHaveLength(1);
    });
    it("deduplicates GPS sync-only delivery and the later real Shopify webhook", async () => {
      await run();
      const shipment = {
        id: 991,
        status: "success",
        created_at: "2026-10-27T01:00:00Z",
        tracking_number: "TRACK",
        line_items: [{ id: 11, quantity: 2 }],
      } as any;
      await fulfillOrderSegments({
        orderId,
        shopDomain: shop,
        gpsOrderId: "GPS-#SEGMENT-TEST",
        fulfillments: [shipment],
        step,
      });
      await fulfillOrderSegments({
        orderId,
        shopDomain: shop,
        fulfillments: [{ ...shipment, id: 992 }],
        step,
      });
      expect(mocks.transport).toHaveBeenCalledTimes(1);
      const saved = await pool.query(
        "SELECT completed FROM public.order_segment_fulfillments WHERE shop_domain=$1",
        [shop]
      );
      expect(saved.rows).toEqual([{ completed: true }]);
      await publishSegmentCompletion(shop, orderId);
      expect((await readPlan(shop, orderId))!.progress["0"].fulfilled).toBe(true);
    });

    it("posts two partial shipments to their own lots and includes services only once", async () => {
      await run();
      const shipment = {
        id: 991,
        status: "success",
        created_at: "2026-10-27T01:00:00Z",
        tracking_number: "TRACK1",
        line_items: [{ id: 11, quantity: 1 }],
      } as any;
      await fulfillOrderSegments({ orderId, shopDomain: shop, fulfillments: [shipment], step });
      await fulfillOrderSegments({
        orderId,
        shopDomain: shop,
        fulfillments: [{ ...shipment, id: 992, tracking_number: "TRACK2" }],
        step,
      });
      const requests = mocks.fulfill.mock.calls.map(([request]) => request);
      expect(requests.map((r) => r.salesOrderNumber)).toEqual(["SEG-TEST-SO-1", "SEG-TEST-SO-1"]);
      expect(requests.map((r) => r.lines[0].quantity)).toEqual([1, 1]);
      expect(requests[0].lines.length).toBeGreaterThan(1);
      expect(requests[1].lines).toHaveLength(1);
      expect(mocks.transport).toHaveBeenCalledTimes(2);
    });
    it("uses the original posting date when a later Shopify callback recovers a GPS posting", async () => {
      await run();
      const shipment = {
        id: 991,
        status: "success",
        created_at: "2026-10-27T01:00:00Z",
        tracking_number: "TRACK",
        line_items: [{ id: 11, quantity: 2 }],
      } as any;
      let fail = true;
      mocks.query.mockImplementation(async (sql, values) => {
        if (fail && sql.startsWith("UPDATE public.order_segment_fulfillments")) {
          fail = false;
          throw new Error("completion unavailable");
        }
        return pool.query(sql, values);
      });
      await expect(
        fulfillOrderSegments({
          orderId,
          shopDomain: shop,
          gpsOrderId: "GPS-#SEGMENT-TEST",
          fulfillments: [shipment],
          step,
        })
      ).rejects.toThrow("completion unavailable");
      await fulfillOrderSegments({
        orderId,
        shopDomain: shop,
        fulfillments: [{ ...shipment, id: 992, created_at: "2026-10-28T01:00:00Z" }],
        step,
      });
      expect(mocks.transport).toHaveBeenCalledTimes(1);
      expect(mocks.fulfill.mock.calls.map(([request]) => request.confirmedShippedDate)).toEqual([
        "2026-10-27",
        "2026-10-27",
      ]);
    });

    it("ignores virtual gift-card receipts while processing physical shipments", async () => {
      await run();
      const shipment = {
        id: 991,
        status: "success",
        created_at: "2026-10-27T01:00:00Z",
        tracking_number: "TRACK",
        line_items: [{ id: 11, quantity: 2 }],
      } as any;
      const result = await fulfillOrderSegments({
        orderId,
        shopDomain: shop,
        fulfillments: [{ ...shipment, id: 990, line_items: [{ id: 999, quantity: 1 }] }, shipment],
        step,
      });
      expect(result!.results.map((result) => result.fulfillmentId)).toEqual([991]);
      expect(mocks.transport).toHaveBeenCalledTimes(1);
    });

    it("stops before later provider writes when recovery eligibility changes", async () => {
      let checks = 0;
      const ensureEligible = vi.fn(async () => {
        if (++checks >= 3) throw new Error("cancelled");
      });
      await expect(
        processOrderSegments({
          order,
          step,
          shopDomain: shop,
          fallbackDataArea: "H007",
          ensureEligible,
          accounting: {
            paymentId: "actual-payment",
            giftCardApplications: [],
            purchasedGiftCards: {},
          },
        })
      ).rejects.toThrow("cancelled");
      expect(mocks.header).toHaveBeenCalledTimes(2);
      expect(gpsPosts).toEqual([]);
    });

    it("executes a mixed-company plan with independent durable provider orders", async () => {
      nodes = new Map([
        ["51", 3],
        ["52", 2],
      ]);
      sequence = 52;
      mocks.area.mockImplementation(async (location) => (location === "71" ? "H007" : "U001"));
      mocks.fos.mockResolvedValue([
        {
          id: 51,
          assigned_location_id: 71,
          status: "open",
          line_items: [{ id: 81, line_item_id: 11, fulfillable_quantity: 3 }],
        },
        {
          id: 52,
          assigned_location_id: 72,
          status: "open",
          line_items: [{ id: 82, line_item_id: 11, fulfillable_quantity: 2 }],
        },
      ]);
      await run();
      expect(mocks.header.mock.calls.map((call) => call[0].dataAreaId).sort()).toEqual([
        "H007",
        "H007",
        "U001",
      ]);
      const saved = await readPlan(shop, orderId);
      expect(saved?.plan.segments).toHaveLength(3);
      expect(Object.values(saved!.progress).every((progress) => progress.completed)).toBe(true);
      await run();
      expect(mocks.header).toHaveBeenCalledTimes(3);
    });

    it("serializes completion publication so stale snapshots cannot overwrite completion", async () => {
      await run();
      const stored = (await readPlan(shop, orderId))!;
      for (const [index, id, qty] of [
        [0, "52", 2],
        [1, "53", 2],
        [2, "51", 1],
      ] as const)
        await reserveAllocations(
          shop,
          stored,
          `complete-${index}`,
          [id],
          { "11": qty },
          "2026-10-27"
        );
      let release!: () => void, entered!: () => void;
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const firstEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      mocks.hub.mockImplementationOnce(async () => {
        entered();
        await waiting;
      });
      const first = publishSegmentCompletion(shop, orderId);
      await firstEntered;
      await pool.query(
        "UPDATE public.order_segment_fulfillments SET completed=true WHERE shop_domain=$1",
        [shop]
      );
      const second = publishSegmentCompletion(shop, orderId);
      release();
      await Promise.all([first, second]);
      expect(mocks.hub.mock.calls.at(-1)![0].d365FulfillmentStatus).toBe("synced");
      expect(
        Object.values((await readPlan(shop, orderId))!.progress).every(
          (progress) => progress.fulfilled
        )
      ).toBe(true);
    });

    it("does not recancel successful segments after a later cancellation times out", async () => {
      await run();
      mocks.cancel
        .mockResolvedValueOnce({ success: true })
        .mockRejectedValueOnce(new Error("timeout"));
      await expect(cancelOrderSegments(shop, orderId, step)).rejects.toThrow(
        "requires reconciliation"
      );
      await expect(cancelOrderSegments(shop, orderId, step)).rejects.toThrow(
        "requires reconciliation"
      );
      expect(mocks.cancel).toHaveBeenCalledTimes(2);
      expect((await readPlan(shop, orderId))!.progress["0"].cancelled).toBe(true);
    });
  }
);
