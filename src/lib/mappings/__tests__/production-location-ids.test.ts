import { describe, it, expect, vi, afterEach } from "vitest";

describe("production-location-ids", () => {
  const envSnapshot = { ...process.env };

  afterEach(() => {
    vi.resetModules();
    process.env = { ...envSnapshot };
  });

  it("maps non-empty SHOPIFY_TEST_LOCATION_* ids when SHOPIFY_STORE_MODE=test", async () => {
    process.env.SHOPIFY_STORE_MODE = "test";
    process.env.NODE_ENV = "test";
    process.env.SHOPIFY_TEST_SHOP_DOMAIN = "test.myshopify.com";
    process.env.SHOPIFY_TEST_ACCESS_TOKEN = "shpat_test";
    process.env.SHOPIFY_TEST_LOCATION_GPS = "79527313640";
    process.env.SHOPIFY_TEST_LOCATION_GPS_UK = "82997936360";
    process.env.SHOPIFY_TEST_LOCATION_STORD = "83243204840";
    process.env.SHOPIFY_TEST_LOCATION_HK = "";

    const { ACTIVE_SHOPIFY_LOCATION_MAPPINGS } = await import("../production-location-ids");

    expect(ACTIVE_SHOPIFY_LOCATION_MAPPINGS).toHaveLength(3);
    const byWh = Object.fromEntries(
      ACTIVE_SHOPIFY_LOCATION_MAPPINGS.map((m) => [m.warehouseName, m.shopifyLocationId])
    );
    expect(byWh["GPS Warehouse"]).toBe("79527313640");
    expect(byWh["GPS UK Warehouse"]).toBe("82997936360");
    expect(byWh["STORD ATL Location"]).toBe("83243204840");
  });

  it("maps SHOPIFY_PROD_LOCATION_* when SHOPIFY_STORE_MODE=production", async () => {
    process.env.SHOPIFY_STORE_MODE = "production";
    process.env.NODE_ENV = "production";
    process.env.SHOPIFY_PROD_SHOP_DOMAIN = "prod.myshopify.com";
    process.env.SHOPIFY_PROD_ACCESS_TOKEN = "shpat_prod";
    process.env.SHOPIFY_PROD_LOCATION_GPS = "111";
    process.env.SHOPIFY_PROD_LOCATION_GPS_UK = "222";
    process.env.SHOPIFY_PROD_LOCATION_STORD = "333";
    process.env.SHOPIFY_PROD_LOCATION_HK = "444";

    const { ACTIVE_SHOPIFY_LOCATION_MAPPINGS } = await import("../production-location-ids");

    expect(ACTIVE_SHOPIFY_LOCATION_MAPPINGS).toHaveLength(4);
    expect(ACTIVE_SHOPIFY_LOCATION_MAPPINGS.map((m) => m.shopifyLocationId).sort()).toEqual([
      "111",
      "222",
      "333",
      "444",
    ]);
  });

  it("isProductionEnvironment respects USE_STATIC_LOCATION_IDS", async () => {
    process.env.USE_STATIC_LOCATION_IDS = "true";
    process.env.NODE_ENV = "development";
    const { isProductionEnvironment } = await import("../production-location-ids");
    expect(isProductionEnvironment()).toBe(true);

    vi.resetModules();
    process.env = { ...envSnapshot };
    process.env.USE_STATIC_LOCATION_IDS = "false";
    process.env.NODE_ENV = "production";
    const mod2 = await import("../production-location-ids");
    expect(mod2.isProductionEnvironment()).toBe(false);
  });
});
