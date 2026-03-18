/**
 * E2E: Location / Country / DataAreaId Routing
 *
 * Exhaustive test of the routing chain:
 *   countryCode → countryRouting → warehouseName → dataAreaId
 *
 * Verifies:
 *   1. Every country in warehouse-config.json routes to the correct warehouse
 *   2. Every warehouse has the correct dataAreaId
 *   3. Every warehouse has valid fulfilment and return configs
 *   4. Service SKUs are set for every warehouse
 *   5. GPS-only warehouses are correctly identified
 *   6. STORD warehouses are correctly identified
 *   7. Fixture orders route to the expected warehouse based on shipping address
 *
 * These tests run without API calls (pure config validation).
 */

import { describe, it, expect } from "vitest";
import {
  getWarehouseConfig,
  determineWarehouse,
  resolveCountryRouting,
  getShippingSku,
  getTaxSku,
  getRefundSku,
  getReturnConfig,
  isGpsWarehouse,
  isStordWarehouse,
  type WarehouseName,
} from "@/lib/helpers/warehouse";
import {
  toD365SalesOrderHeaderV3,
  toD365SalesOrderLines,
  shouldSendToGps,
} from "@/lib/transformers/order";
import { isServiceSku } from "@/lib/transformers/sku";
import { loadAllFixtures } from "../fixtures";
import warehouseConfig from "@/lib/mappings/warehouse-config.json";

describe("E2E: Routing Verification", () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // Section 1 — Warehouse config completeness
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Warehouse config completeness", () => {
    const warehouseNames = Object.keys(warehouseConfig.warehouses) as WarehouseName[];

    for (const name of warehouseNames) {
      describe(`${name}`, () => {
        const cfg = getWarehouseConfig(name);

        it("has a valid dataAreaId", () => {
          expect(cfg.dataAreaId).toBeTruthy();
          expect(cfg.dataAreaId.length).toBeGreaterThanOrEqual(4);
        });

        it("has a valid orderingCustomerAccountNumber", () => {
          expect(cfg.orderingCustomerAccountNumber).toBeTruthy();
          expect(cfg.orderingCustomerAccountNumber).toContain("-C");
        });

        it("has fulfilment config with all required fields", () => {
          expect(cfg.fulfilment.shippingSiteId).toBeTruthy();
          expect(cfg.fulfilment.shippingWarehouseId).toBeTruthy();
          expect(cfg.fulfilment.shippingWarehouseLocationId).toBeTruthy();
        });

        it("has return config with all required fields", () => {
          expect(cfg.return.shippingSiteId).toBeTruthy();
          expect(cfg.return.shippingWarehouseId).toBeTruthy();
          expect(cfg.return.shippingWarehouseLocationId).toBe("Return");
        });

        it("has service SKUs defined", () => {
          expect(cfg.item.tax).toBeTruthy();
          expect(cfg.item.refund).toBeTruthy();
          expect(cfg.item.shipping).toBeTruthy();
          expect(isServiceSku(cfg.item.tax)).toBe(true);
          expect(isServiceSku(cfg.item.refund)).toBe(true);
          expect(isServiceSku(cfg.item.shipping)).toBe(true);
        });

        it("service SKU helpers return matching values", () => {
          expect(getTaxSku(name)).toBe(cfg.item.tax);
          expect(getRefundSku(name)).toBe(cfg.item.refund);
          expect(getShippingSku(name)).toBe(cfg.item.shipping);
        });

        it("return config helpers return matching values", () => {
          const ret = getReturnConfig(name);
          expect(ret.shippingSiteId).toBe(cfg.return.shippingSiteId);
          expect(ret.shippingWarehouseId).toBe(cfg.return.shippingWarehouseId);
          expect(ret.shippingWarehouseLocationId).toBe(cfg.return.shippingWarehouseLocationId);
        });
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 2 — Country routing exhaustive coverage
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Country routing (all configured countries)", () => {
    const routingTable = warehouseConfig.countryRouting as Record<string, string>;

    for (const [country, expectedWarehouse] of Object.entries(routingTable)) {
      it(`${country} → ${expectedWarehouse}`, () => {
        const result = resolveCountryRouting(country);
        expect(result.warehouseName).toBe(expectedWarehouse);
        expect(result.countryCode).toBe(country);
        expect(result.source).toBe("country_config");

        const warehouseCfg = getWarehouseConfig(expectedWarehouse);
        expect(result.dataAreaId).toBe(warehouseCfg.dataAreaId);
      });
    }
  });

  describe("DataAreaId mapping by warehouse", () => {
    const expectedMapping = {
      "GPS Warehouse": "U001",
      "GPS UK Warehouse": "H007",
      "STORD ATL Location": "U001",
      "HK Warehouse": "H007",
    };

    for (const [warehouse, expectedDataAreaId] of Object.entries(expectedMapping)) {
      it(`${warehouse} → dataAreaId = ${expectedDataAreaId}`, () => {
        const cfg = getWarehouseConfig(warehouse);
        expect(cfg.dataAreaId).toBe(expectedDataAreaId);
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 3 — GPS vs STORD warehouse identification
  // ═══════════════════════════════════════════════════════════════════════════

  describe("GPS warehouse identification", () => {
    it("GPS Warehouse is a GPS warehouse", () => {
      expect(isGpsWarehouse("GPS Warehouse")).toBe(true);
      expect(isStordWarehouse("GPS Warehouse")).toBe(false);
    });

    it("GPS UK Warehouse is a GPS warehouse", () => {
      expect(isGpsWarehouse("GPS UK Warehouse")).toBe(true);
      expect(isStordWarehouse("GPS UK Warehouse")).toBe(false);
    });

    it("STORD ATL Location is a STORD warehouse", () => {
      expect(isGpsWarehouse("STORD ATL Location")).toBe(false);
      expect(isStordWarehouse("STORD ATL Location")).toBe(true);
    });

    it("HK Warehouse is neither GPS nor STORD", () => {
      expect(isGpsWarehouse("HK Warehouse")).toBe(false);
      expect(isStordWarehouse("HK Warehouse")).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 4 — Fixture orders route correctly
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Fixture order routing", () => {
    const fixtures = loadAllFixtures();

    const fixtureExpectations: Array<{
      fixtureName: keyof typeof fixtures;
      expectedCountry: string;
      expectedWarehouse: string;
      expectedDataAreaId: string;
      shouldGoToGps: boolean;
    }> = [
      {
        fixtureName: "gpsUsOrder",
        expectedCountry: "US",
        expectedWarehouse: "GPS Warehouse",
        expectedDataAreaId: "U001",
        shouldGoToGps: true,
      },
      {
        fixtureName: "gpsUkOrder",
        expectedCountry: "GB",
        expectedWarehouse: "GPS UK Warehouse",
        expectedDataAreaId: "H007",
        shouldGoToGps: true,
      },
      {
        fixtureName: "hkOrder",
        expectedCountry: "HK",
        expectedWarehouse: "HK Warehouse",
        expectedDataAreaId: "H007",
        shouldGoToGps: false,
      },
      {
        fixtureName: "stordOrder",
        expectedCountry: "US",
        // STORD routing is location-based, not country-based.
        // Country "US" routes to GPS Warehouse by default; Shopify location overrides to STORD.
        expectedWarehouse: "GPS Warehouse",
        expectedDataAreaId: "U001",
        // When explicitly given STORD ATL Location, GPS sync should be false
        shouldGoToGps: false,
      },
    ];

    for (const tc of fixtureExpectations) {
      describe(`${tc.fixtureName}`, () => {
        const order = fixtures[tc.fixtureName];

        it(`ships to ${tc.expectedCountry}`, () => {
          const country = order.shipping_address?.country_code || "US";
          expect(country).toBe(tc.expectedCountry);
        });

        it(`routes to ${tc.expectedWarehouse}`, () => {
          const country = order.shipping_address?.country_code || "US";
          const warehouse = determineWarehouse(country);
          expect(warehouse).toBe(tc.expectedWarehouse);
        });

        it(`uses dataAreaId ${tc.expectedDataAreaId}`, () => {
          const header = toD365SalesOrderHeaderV3(order, tc.expectedWarehouse);
          expect(header.dataAreaId).toBe(tc.expectedDataAreaId);
        });

        it(`GPS routing: shouldSendToGps = ${tc.shouldGoToGps}`, () => {
          // STORD fixture uses explicit warehouse override; all others use country-derived warehouse
          const warehouseForGpsCheck =
            tc.fixtureName === "stordOrder" ? "STORD ATL Location" : tc.expectedWarehouse;
          expect(shouldSendToGps(order, warehouseForGpsCheck)).toBe(tc.shouldGoToGps);
        });

        it("D365 lines have correct dataAreaId", () => {
          const lines = toD365SalesOrderLines(
            order,
            `${tc.expectedDataAreaId}-SO-TEST`,
            tc.expectedWarehouse
          );
          for (const line of lines) {
            expect(line.dataAreaId).toBe(tc.expectedDataAreaId);
          }
        });
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 5 — Service SKU per-warehouse cross-reference
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Service SKU cross-reference (spock-store verified)", () => {
    const spockStoreReference = {
      "GPS Warehouse": {
        tax: "IM8-SER-000004",
        refund: "IM8-SER-000005",
        shipping: "IM8-SER-000002",
      },
      "GPS UK Warehouse": {
        tax: "IM8-SER-000004",
        refund: "IM8-SER-000005",
        shipping: "IM8-SER-000002",
      },
      "HK Warehouse": {
        tax: "IM8-SER-000004",
        refund: "IM8-SER-000005",
        shipping: "IM8-SER-000002",
      },
      "STORD ATL Location": {
        tax: "IM8-SER-000004",
        refund: "IM8-SER-000005",
        shipping: "IM8-SER-000003",
      },
    };

    for (const [warehouse, expected] of Object.entries(spockStoreReference)) {
      it(`${warehouse} matches spock-store: tax=${expected.tax}, refund=${expected.refund}, shipping=${expected.shipping}`, () => {
        const cfg = getWarehouseConfig(warehouse);
        expect(cfg.item.tax).toBe(expected.tax);
        expect(cfg.item.refund).toBe(expected.refund);
        expect(cfg.item.shipping).toBe(expected.shipping);
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 6 — Edge cases
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Routing edge cases", () => {
    it("empty country code falls back to default", () => {
      const result = resolveCountryRouting("");
      expect(result.source).toBe("default");
    });

    it("lowercase country code is normalized", () => {
      const result = resolveCountryRouting("us");
      expect(result.warehouseName).toBe("GPS Warehouse");
      expect(result.countryCode).toBe("US");
    });

    it("throws on unknown warehouse name", () => {
      expect(() => getWarehouseConfig("NonExistent Warehouse")).toThrow("Unknown warehouse");
    });

    it("all GPS warehouses are in gpsWarehouses config", () => {
      for (const name of warehouseConfig.gpsWarehouses) {
        expect(isGpsWarehouse(name)).toBe(true);
        const cfg = getWarehouseConfig(name);
        expect(cfg.gpsCode).toBeTruthy();
      }
    });

    it("all STORD warehouses are in stordWarehouses config", () => {
      for (const name of warehouseConfig.stordWarehouses) {
        expect(isStordWarehouse(name)).toBe(true);
      }
    });

    it("STORD routing is location-based, not country-based (US → GPS by default)", () => {
      const warehouse = determineWarehouse("US");
      expect(warehouse).toBe("GPS Warehouse");
      expect(isGpsWarehouse(warehouse)).toBe(true);

      // STORD is only reached via Shopify fulfillment location override
      expect(isStordWarehouse("STORD ATL Location")).toBe(true);
      expect(shouldSendToGps(loadAllFixtures().stordOrder, "STORD ATL Location")).toBe(false);

      // But when treated as GPS Warehouse (country routing), it would go to GPS
      expect(shouldSendToGps(loadAllFixtures().stordOrder, "GPS Warehouse")).toBe(true);
    });
  });
});
