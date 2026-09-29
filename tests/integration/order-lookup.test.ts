import { describe, it, expect, vi } from "vitest";
import { fetchD365HintByShopifyOrderId } from "@/lib/services/order-lookup";

const hasDatabase = !!(
  process.env.DATABASE_URL ||
  (process.env.CLOUD_SQL_INSTANCE_CONNECTION_NAME && process.env.DB_NAME && process.env.DB_USER)
);

describe.skipIf(!hasDatabase)("fetchD365HintByShopifyOrderId (live PostgreSQL)", () => {
  it("returns d365_order_number row when Hub has synced the order", async () => {
    const shopifyOrderId =
      process.env.TEST_REFUND_SHOPIFY_ORDER_ID ||
      process.env.TEST_SHOPIFY_ORDER_ID ||
      "6993154474216";

    const hint = await fetchD365HintByShopifyOrderId(shopifyOrderId);

    if (!hint) {
      console.warn(
        `[order-lookup test] No row with d365_order_number for shopify_order_id=${shopifyOrderId}. ` +
          "Set TEST_REFUND_SHOPIFY_ORDER_ID to an id that exists in orders."
      );
    }

    expect(hint).toBeDefined();
    expect(hint?.d365OrderNumber).toBeTruthy();
    expect(typeof hint?.d365OrderNumber).toBe("string");
  });
});

describe("fetchD365HintByShopifyOrderId (no credentials)", () => {
  it("returns null when PostgreSQL is not configured", async () => {
    vi.resetModules();
    const previous = {
      DATABASE_URL: process.env.DATABASE_URL,
      CLOUD_SQL_INSTANCE_CONNECTION_NAME: process.env.CLOUD_SQL_INSTANCE_CONNECTION_NAME,
      DB_NAME: process.env.DB_NAME,
      DB_USER: process.env.DB_USER,
    };
    delete process.env.DATABASE_URL;
    delete process.env.CLOUD_SQL_INSTANCE_CONNECTION_NAME;
    delete process.env.DB_NAME;
    delete process.env.DB_USER;

    const { fetchD365HintByShopifyOrderId: fetchHint } =
      await import("@/lib/services/order-lookup");
    const result = await fetchHint("123");
    expect(result).toBeNull();

    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
});
