import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { loadFixture } from "../fixtures";
const mocks = vi.hoisted(() => ({
  pool: vi.fn(),
  query: vi.fn(),
  headers: vi.fn(),
  slips: vi.fn(),
}));
vi.mock("@/lib/db/database", () => ({ getDatabasePool: mocks.pool, queryDatabase: mocks.query }));
vi.mock("@/lib/clients/dynamics/reconciliation", () => ({
  readHeaderEvidence: mocks.headers,
  readSlipEvidence: mocks.slips,
}));
import { reserveSegmentRefund } from "@/lib/services/order-segments/refunds/store";
import { executeFulfillmentAction } from "@/lib/services/fulfillment-actions/ledger";
import { reconcileFulfillmentAttempt } from "@/lib/services/fulfillment-actions/recovery";
import { config } from "@/lib/config";
import type { StoredPlan } from "@/lib/services/order-segments/types";
import type { ShopifyRefundPayload } from "@/inngest/events";
const shop = "operational-fixture.myshopify.com",
  orderId = "99123";
const providerOrder = "OPERATIONAL-TEST-SO";
const scope = `${config.dynamics.baseUrl}:H007`;
describe.skipIf(!process.env.FULFILLMENT_TEST_DATABASE_URL)(
  "operational recovery PostgreSQL invariants",
  () => {
    let pool: Pool;
    beforeAll(() => {
      pool = new Pool({ connectionString: process.env.FULFILLMENT_TEST_DATABASE_URL });
      mocks.pool.mockResolvedValue(pool);
      mocks.query.mockImplementation((sql, values) => pool.query(sql, values));
    });
    beforeEach(async () => {
      await pool.query("DELETE FROM public.order_segment_refunds WHERE shop_domain=$1", [shop]);
      await pool.query("DELETE FROM public.order_segment_plans WHERE shop_domain=$1", [shop]);
      await pool.query("DELETE FROM public.fulfillment_action_aliases WHERE source_order_id=$1", [
        providerOrder,
      ]);
      await pool.query("DELETE FROM public.fulfillment_actions WHERE source_order_id=$1", [
        providerOrder,
      ]);
      await pool.query(
        "DELETE FROM public.fulfillment_evidence_claims WHERE document_id LIKE 'OPERATIONAL-TEST-SO:%'"
      );
      mocks.headers.mockResolvedValue([
        {
          dataAreaId: "h007",
          SalesOrderNumber: providerOrder,
          THK_ShopifyReference: "O",
          CurrencyCode: "USD",
          SalesOrderProcessingStatus: "Invoiced",
        },
      ]);
      mocks.slips.mockResolvedValue([
        {
          dataAreaId: "h007",
          SalesId: providerOrder,
          PackingSlipId: "PS1",
          InventTransId: "lot",
          ItemId: "sku",
          Qty: 1,
          DeliveryDate: "2026-10-28",
        },
      ]);
    });
    afterAll(async () => {
      await pool?.end();
    });
    it("reserves one immutable refund across concurrent workers and counts unfinished reservations", async () => {
      const order = loadFixture("multiLineOrder");
      order.id = Number(orderId);
      const line = order.line_items[0];
      const stored: StoredPlan = {
        plan: {
          version: 1,
          inputHash: "h",
          orderId,
          orderName: order.name,
          segments: [0, 1].map((index) => ({
            index,
            sourceFulfillmentOrderId: String(index),
            locationId: "l",
            warehouse: "GPS Warehouse",
            dataAreaId: index ? "H007" : "U001",
            lines: [{ lineItemId: String(line.id), physical: true, quantity: 1 }],
          })),
        },
        progress: {},
      };
      await pool.query(
        "INSERT INTO public.order_segment_plans(shop_domain,shopify_order_id,plan) VALUES($1,$2,$3)",
        [shop, orderId, JSON.stringify(stored.plan)]
      );
      const refund: ShopifyRefundPayload = {
        id: 1,
        order_id: Number(orderId),
        created_at: "2026-10-28",
        transactions: [],
        refund_line_items: [
          {
            id: 1,
            line_item_id: line.id,
            line_item: line,
            quantity: 2,
            subtotal: "1.01",
            total_tax: "0",
          },
        ],
      };
      const results = await Promise.all(
        Array.from({ length: 8 }, () => reserveSegmentRefund(shop, stored, order, refund, 101))
      );
      for (const result of results) expect(result.allocations).toEqual(results[0].allocations);
      expect(results[0].allocations.map((a) => a.amountCents)).toEqual([51, 50]);
      expect(
        (
          await pool.query("SELECT * FROM public.order_segment_refunds WHERE shop_domain=$1", [
            shop,
          ])
        ).rows
      ).toHaveLength(1);
      await expect(
        reserveSegmentRefund(shop, stored, order, { ...refund, id: 2 }, 101)
      ).rejects.toThrow("exceeds");
    });
    async function uncertain(action = "shipment:test") {
      const identity = {
        provider: "dynamics" as const,
        scope,
        sourceOrderId: providerOrder,
        sourceLineIds: ["lot"],
        action,
      };
      await expect(
        executeFulfillmentAction(
          identity,
          { qty: 1 },
          async () => {
            throw new Error("timeout");
          },
          {
            version: 1,
            kind: "d365_shipment",
            company: "H007",
            salesOrderNumber: providerOrder,
            postingDate: "2026-10-28",
            lines: [{ lotId: "lot", itemNumber: "sku", quantity: 1 }],
          }
        )
      ).rejects.toThrow("requires reconciliation");
      const rows = await pool.query(
        "UPDATE public.fulfillment_actions SET updated_at=now()-interval '10 minutes' WHERE source_order_id=$1 RETURNING attempt_id",
        [providerOrder]
      );
      return rows.rows[0].attempt_id as string;
    }
    it("claims one provider document and resolves the entire action under concurrent verification", async () => {
      const id = await uncertain();
      const outcomes = await Promise.allSettled([
        reconcileFulfillmentAttempt(id),
        reconcileFulfillmentAttempt(id),
      ]);
      expect(outcomes.filter((r) => r.status === "fulfilled" && r.value.resolved)).toHaveLength(1);
      expect(
        (
          await pool.query(
            "SELECT status FROM public.fulfillment_actions WHERE source_order_id=$1",
            [providerOrder]
          )
        ).rows
      ).toEqual([{ status: "succeeded" }]);
      expect(
        (
          await pool.query("SELECT * FROM public.fulfillment_evidence_claims WHERE attempt_id=$1", [
            id,
          ])
        ).rows
      ).toHaveLength(1);
    });
    it("will not assign an earlier successful shipment document to a new ambiguous operation", async () => {
      await executeFulfillmentAction(
        {
          provider: "dynamics",
          scope,
          sourceOrderId: providerOrder,
          sourceLineIds: ["lot"],
          action: "shipment:earlier",
        },
        {},
        async () => ({ status: 1 })
      );
      const id = await uncertain("shipment:later");
      const later = (
        await pool.query(
          "SELECT attempt_id FROM public.fulfillment_actions WHERE source_order_id=$1 AND status='uncertain'",
          [providerOrder]
        )
      ).rows[0].attempt_id;
      expect(id).toBeTruthy();
      await expect(reconcileFulfillmentAttempt(later)).rejects.toThrow("another shipment");
      expect(
        (
          await pool.query("SELECT * FROM public.fulfillment_evidence_claims WHERE attempt_id=$1", [
            later,
          ])
        ).rows
      ).toHaveLength(0);
    });
  }
);
