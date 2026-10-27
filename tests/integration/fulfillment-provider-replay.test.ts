import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import type { D365FulfilmentRequest } from "@/lib/types/dynamics";
const { getPool } = vi.hoisted(() => ({ getPool: vi.fn() }));
vi.mock("@/lib/db/database", () => ({ getDatabasePool: getPool }));
vi.mock("@/lib/services/flow-logs", () => ({ logFlowEvent: vi.fn() }));

const fulfillment: D365FulfilmentRequest = {
  fulfillmentId: "shopify:replay-test",
  salesOrderNumber: "provider-replay-test",
  dataAreaId: "U001",
  type: "shipment",
  confirmedShippedDate: "2026-10-20",
  lines: [{ lotId: "LOT-1", itemNumber: "SKU", quantity: 1, shippingSiteId: "U001" }],
};

describe.skipIf(!process.env.FULFILLMENT_TEST_DATABASE_URL)(
  "provider replay through PostgreSQL",
  () => {
    let pool: Pool;
    let postFulfillment: typeof import("@/lib/clients/dynamics/fulfillment").postDurableFulfilment;
    beforeAll(async () => {
      vi.stubEnv("D365_BASE_URL", "https://d365.example");
      vi.stubEnv("GPS_BASE_URL", "https://gps.example");
      vi.stubEnv("OMS_MIN_INTERVAL_MS", "0");
      pool = new Pool({ connectionString: process.env.FULFILLMENT_TEST_DATABASE_URL });
      getPool.mockResolvedValue(pool);
      postFulfillment = (await import("@/lib/clients/dynamics/fulfillment")).postDurableFulfilment;
    });
    beforeEach(async () => {
      await pool.query(
        "DELETE FROM public.fulfillment_action_aliases WHERE source_order_id='provider-replay-test'"
      );
      await pool.query(
        "DELETE FROM public.fulfillment_actions WHERE source_order_id='provider-replay-test'"
      );
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });
    afterAll(async () => {
      await pool?.end();
      vi.unstubAllEnvs();
    });

    const transport = () => ({
      authenticate: async () => "synthetic-token",
      fetch: vi
        .fn<typeof fetch>()
        .mockImplementation(async () =>
          Response.json({ status: 1, Message: "ok", Result: "PS-1", $id: "1" })
        ),
    });
    const tracked = (trackingNumber: string, fulfillmentId = fulfillment.fulfillmentId) => ({
      ...fulfillment,
      fulfillmentId,
      lines: [{ ...fulfillment.lines[0], trackingNumber }],
    });

    it("replays one fulfillment when tracking is added, corrected, removed, or restored", async () => {
      const provider = transport();
      for (const req of [
        fulfillment,
        tracked("TRACK-1"),
        tracked("TRACK-2"),
        fulfillment,
        tracked("TRACK-1"),
      ]) {
        expect((await postFulfillment(req, provider)).response.Result).toBe("PS-1");
      }
      expect(provider.fetch).toHaveBeenCalledTimes(1);
      const rows = (
        await pool.query(
          "SELECT action_name, attempts FROM public.fulfillment_actions WHERE source_order_id='provider-replay-test'"
        )
      ).rows;
      expect(rows).toEqual([{ action_name: "shipment:shopify:replay-test", attempts: 1 }]);
    });

    it("binds a GPS alias to the original shipment and preserves it after tracking changes", async () => {
      const provider = transport();
      await postFulfillment(tracked("TRACK-1"), provider);
      await postFulfillment(tracked("TRACK-1", "gps:replay-test"), provider);
      await postFulfillment(tracked("TRACK-2", "gps:replay-test"), provider);
      await postFulfillment(tracked("TRACK-2"), provider);
      expect(provider.fetch).toHaveBeenCalledTimes(1);
    });

    it("reserves once across concurrent source aliases", async () => {
      const provider = transport();
      const results = await Promise.allSettled([
        postFulfillment(tracked("TRACK-1"), provider),
        postFulfillment(tracked("TRACK-1", "gps:replay-test"), provider),
      ]);
      expect(results.some((result) => result.status === "fulfilled")).toBe(true);
      await postFulfillment(tracked("TRACK-1", "gps:replay-test"), provider);
      expect(provider.fetch).toHaveBeenCalledTimes(1);
    });

    it("blocks ambiguous outcomes after tracking changes", async () => {
      const provider = transport();
      provider.fetch.mockRejectedValue(new Error("accepted then timed out"));
      await expect(postFulfillment(fulfillment, provider)).rejects.toThrow(
        "requires reconciliation"
      );
      await expect(postFulfillment(tracked("TRACK-NEW"), provider)).rejects.toThrow(
        "requires reconciliation"
      );
      expect(provider.fetch).toHaveBeenCalledTimes(1);
    });

    it("keeps quantity and line-set changes protected while permitting distinct partial shipments", async () => {
      const provider = transport();
      await postFulfillment(tracked("TRACK-1"), provider);
      await expect(
        postFulfillment(
          { ...tracked("TRACK-NEW"), lines: [{ ...fulfillment.lines[0], quantity: 2 }] },
          provider
        )
      ).rejects.toThrow("requires reconciliation");
      await expect(
        postFulfillment(
          { ...fulfillment, lines: [{ ...fulfillment.lines[0], lotId: "OTHER-LOT" }] },
          provider
        )
      ).rejects.toThrow("requires reconciliation");
      await postFulfillment(tracked("TRACK-2", "shopify:distinct-shipment"), provider);
      expect(provider.fetch).toHaveBeenCalledTimes(2);
    });

    it("rejects a tracking alias that already belongs to another completed shipment", async () => {
      const provider = transport();
      await postFulfillment(tracked("TRACK-1"), provider);
      await postFulfillment(tracked("TRACK-2", "shopify:another-shipment"), provider);
      await expect(postFulfillment(tracked("TRACK-2"), provider)).rejects.toThrow(
        "requires reconciliation"
      );
      expect(provider.fetch).toHaveBeenCalledTimes(2);
    });
  }
);
