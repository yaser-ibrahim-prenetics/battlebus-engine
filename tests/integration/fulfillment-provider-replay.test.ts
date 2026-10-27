import { fulfillmentPostingDate } from "@/lib/helpers/fulfillment-date";
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

    it("replays a successful refund across UTC midnight using its immutable source date", async () => {
      const provider = transport();
      const sourceRefund = { id: "refund-midnight", created_at: "2026-10-26T23:59:00Z" };
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        for (const clock of ["2026-10-26T23:59:30Z", "2026-10-27T00:05:00Z"]) {
          vi.setSystemTime(new Date(clock));
          const result = await postFulfillment(
            {
              ...fulfillment,
              fulfillmentId: `refund:${sourceRefund.id}`,
              type: "return",
              confirmedShippedDate: fulfillmentPostingDate(sourceRefund.created_at),
            },
            provider
          );
          expect(result.response.Result).toBe("PS-1");
        }
        expect(provider.fetch).toHaveBeenCalledTimes(1);
        expect(
          JSON.parse(String(provider.fetch.mock.calls[0][1]?.body))._dataContract
            .ConfirmedShippedDate
        ).toBe("2026-10-26");
      } finally {
        vi.useRealTimers();
      }
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
    const gpsOrder = {
      platformOrderNo: "provider-replay-test",
      thirdOrderNo: "SO-1",
      whCode: "JFK01W",
      subOrderType: 1,
      logisticsChannel: "requested-channel",
      receiver: "Synthetic",
      addressOne: "Test",
      cityName: "Test",
      countryRegionCode: "US",
      postCode: "10001",
      productList: [{ sku: "SKU", quantity: 1 }],
    };

    it("replays the saved GPS fallback result from the original request", async () => {
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          Response.json({ code: 200, data: [{ success: false, msg: "invalid logistics channel" }] })
        )
        .mockResolvedValueOnce(
          Response.json({ code: 200, data: [{ success: true, orderNo: "GPS-accepted" }] })
        );
      const { createOutboundOrder } = await import("@/lib/clients/gps");
      const first = await createOutboundOrder(gpsOrder);
      const replay = await createOutboundOrder(gpsOrder);
      expect(first.response.data[0].orderNo).toBe("GPS-accepted");
      expect(replay.response).toEqual(first.response);
      expect(replay.request.data[0].logisticsChannel).toBe("No_Shipping_Service");
      expect(fetch).toHaveBeenCalledTimes(2); // one rejection, one accepted fallback, no replay POST
      expect(
        (
          await pool.query(
            "SELECT status, attempts FROM public.fulfillment_actions WHERE source_order_id='provider-replay-test'"
          )
        ).rows
      ).toEqual([{ status: "succeeded", attempts: 2 }]);
      await expect(
        createOutboundOrder({ ...gpsOrder, productList: [{ sku: "SKU", quantity: 2 }] })
      ).rejects.toThrow("requires reconciliation");
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("blocks original-request replay when the GPS fallback outcome is uncertain", async () => {
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          Response.json({ code: 200, data: [{ success: false, msg: "invalid logistics channel" }] })
        )
        .mockRejectedValueOnce(new Error("fallback accepted then connection lost"));
      const { createOutboundOrder } = await import("@/lib/clients/gps");
      await expect(createOutboundOrder(gpsOrder)).rejects.toThrow("requires reconciliation");
      await expect(createOutboundOrder(gpsOrder)).rejects.toThrow("requires reconciliation");
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  }
);
