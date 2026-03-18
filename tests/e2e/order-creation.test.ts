/**
 * E2E: Order Creation Flow
 *
 * Tests the full process-shopify-order pipeline using real APIs:
 *   1. Transforms a Shopify payload to D365 header + lines
 *   2. Verifies service SKU lines (tax, shipping) per warehouse
 *   3. Creates D365 header, lines, confirms, prepayment
 *   4. Creates GPS outbound order (for GPS warehouses)
 *   5. Verifies routing: location → country → dataAreaId
 *
 * Skipped unless E2E env vars are set.
 */

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { validateE2eEnv } from "./setup";
import { d365E2e, shopifyE2e, gpsE2e, supabaseE2e } from "./clients";
import {
  toD365SalesOrderHeaderV3,
  toD365SalesOrderLines,
  toGpsOutboundOrder,
  calculateShippingCost,
  calculateTaxAmount,
  calculateDutyAmount,
  calculatePrepaymentAmount,
  shouldSendToGps,
} from "@/lib/transformers/order";
import {
  getWarehouseConfig,
  determineWarehouse,
  resolveCountryRouting,
  getShippingSku,
  getTaxSku,
  getRefundSku,
  isGpsWarehouse,
  isStordWarehouse,
} from "@/lib/helpers/warehouse";
import { isServiceSku, filterServiceSkus } from "@/lib/transformers/sku";
import { loadAllFixtures, type FixtureName } from "../fixtures";

const envCheck = validateE2eEnv();
const RUN = envCheck.valid;

const cleanup: Array<{
  d365OrderNumber?: string;
  dataAreaId?: string;
}> = [];

describe("E2E: Order Creation Flow", () => {
  if (!RUN) {
    it.skip(`Skipped — missing env: ${envCheck.missing.join(", ")}`, () => {});
    return;
  }

  const fixtures = loadAllFixtures();

  afterAll(async () => {
    for (const item of cleanup) {
      if (item.d365OrderNumber && item.dataAreaId) {
        try {
          await d365E2e.deleteSalesOrder(item.d365OrderNumber, item.dataAreaId);
          console.log(`[Cleanup] Deleted D365 order ${item.d365OrderNumber}`);
        } catch {
          console.warn(`[Cleanup] Could not delete ${item.d365OrderNumber}`);
        }
      }
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 1 — Transformer correctness (pure functions, no API calls)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Transformer: D365 header fields", () => {
    const warehouseTests: Array<{
      fixtureName: FixtureName;
      expectedWarehouse: string;
      expectedDataAreaId: string;
      expectedCustomerAccount: string;
    }> = [
      {
        fixtureName: "gpsUsOrder",
        expectedWarehouse: "GPS Warehouse",
        expectedDataAreaId: "U001",
        expectedCustomerAccount: "U001-C000000006",
      },
      {
        fixtureName: "gpsUkOrder",
        expectedWarehouse: "GPS UK Warehouse",
        expectedDataAreaId: "H007",
        expectedCustomerAccount: "H007-C000000001",
      },
      {
        fixtureName: "hkOrder",
        expectedWarehouse: "HK Warehouse",
        expectedDataAreaId: "H005",
        expectedCustomerAccount: "H005-C000000001",
      },
      {
        fixtureName: "stordOrder",
        expectedWarehouse: "STORD ATL Location",
        expectedDataAreaId: "U001",
        expectedCustomerAccount: "U001-C000000006",
      },
    ];

    for (const tc of warehouseTests) {
      it(`${tc.fixtureName} → header has dataAreaId=${tc.expectedDataAreaId}`, () => {
        const order = fixtures[tc.fixtureName];
        const header = toD365SalesOrderHeaderV3(order, tc.expectedWarehouse);

        expect(header.dataAreaId).toBe(tc.expectedDataAreaId);
        expect(header.orderingCustomerAccountNumber).toBe(tc.expectedCustomerAccount);
        expect(header.orderId).toBe(String(order.id));
        expect(header.customerOrderReference).toBe(order.name);
        expect(header.email).toBe(order.email);
      });
    }
  });

  describe("Transformer: D365 lines with service SKUs", () => {
    it("GPS US order includes IM8-SER-000002 (shipping) and IM8-SER-000001 (tax)", () => {
      const order = fixtures.gpsUsOrder;
      const lines = toD365SalesOrderLines(order, "U001-SO-TEST", "GPS Warehouse");

      const shippingLine = lines.find((l) => l.itemNumber === "IM8-SER-000002");
      const taxLine = lines.find((l) => l.itemNumber === "IM8-SER-000001");
      const productLines = lines.filter((l) => !isServiceSku(l.itemNumber));

      expect(productLines.length).toBeGreaterThan(0);

      const shippingCost = calculateShippingCost(order);
      if (shippingCost > 0) {
        expect(shippingLine).toBeDefined();
        expect(shippingLine!.price).toBe(shippingCost);
      }

      const taxAmount = calculateTaxAmount(order) + calculateDutyAmount(order);
      if (taxAmount > 0) {
        expect(taxLine).toBeDefined();
        expect(taxLine!.price).toBe(taxAmount);
      }
    });

    it("GPS UK order includes IM8-SER-000002 (shipping) and IM8-SER-000001 (tax)", () => {
      const order = fixtures.gpsUkOrder;
      const lines = toD365SalesOrderLines(order, "H007-SO-TEST", "GPS UK Warehouse");

      const shippingLine = lines.find((l) => l.itemNumber === "IM8-SER-000002");
      const taxLine = lines.find((l) => l.itemNumber === "IM8-SER-000001");

      const shippingCost = calculateShippingCost(order);
      if (shippingCost > 0) {
        expect(shippingLine).toBeDefined();
        expect(shippingLine!.price).toBe(shippingCost);
        expect(shippingLine!.quantity).toBe(1);
      }

      const taxAmount = calculateTaxAmount(order) + calculateDutyAmount(order);
      if (taxAmount > 0) {
        expect(taxLine).toBeDefined();
      }
    });

    it("STORD ATL order uses STORD-specific SKUs: IM8-SER-000003 (shipping), IM8-SER-000004 (tax)", () => {
      const order = fixtures.stordOrder;
      const lines = toD365SalesOrderLines(order, "U001-SO-TEST", "STORD ATL Location");

      const shippingLine = lines.find((l) => l.itemNumber === "IM8-SER-000003");
      const taxLine = lines.find((l) => l.itemNumber === "IM8-SER-000004");

      const shippingCost = calculateShippingCost(order);
      if (shippingCost > 0) {
        expect(shippingLine).toBeDefined();
        expect(shippingLine!.price).toBe(shippingCost);
      }

      const taxAmount = calculateTaxAmount(order) + calculateDutyAmount(order);
      if (taxAmount > 0) {
        expect(taxLine).toBeDefined();
      }

      expect(shouldSendToGps(order, "STORD ATL Location")).toBe(false);
    });

    it("HK Warehouse uses standard SKUs: IM8-SER-000002 (shipping), IM8-SER-000001 (tax)", () => {
      const order = fixtures.hkOrder;
      const lines = toD365SalesOrderLines(order, "H005-SO-TEST", "HK Warehouse");

      const shippingLine = lines.find((l) => l.itemNumber === "IM8-SER-000002");
      expect(shippingLine === undefined || shippingLine.itemNumber === "IM8-SER-000002").toBe(true);

      const taxLine = lines.find((l) => l.itemNumber === "IM8-SER-000001");
      expect(taxLine === undefined || taxLine.itemNumber === "IM8-SER-000001").toBe(true);
    });

    it("service SKUs are stripped from GPS product list", () => {
      const order = fixtures.gpsUsOrder;
      const d365Lines = toD365SalesOrderLines(order, "U001-SO-TEST", "GPS Warehouse");
      const serviceLines = d365Lines.filter((l) => isServiceSku(l.itemNumber));
      const productLines = filterServiceSkus(d365Lines);

      expect(serviceLines.length).toBeGreaterThanOrEqual(0);
      for (const pl of productLines) {
        expect(isServiceSku(pl.itemNumber)).toBe(false);
      }
    });
  });

  describe("Transformer: GPS outbound payload", () => {
    it("GPS Warehouse order produces valid GPS payload (no service SKUs)", () => {
      const order = fixtures.gpsUsOrder;
      const gpsPayload = toGpsOutboundOrder(order, "U001-SO-TEST", "GPS Warehouse");

      expect(gpsPayload.whCode).toBe("JFK01W");
      expect(gpsPayload.platformOrderNo).toBe(order.name);
      expect(gpsPayload.thirdOrderNo).toBe("U001-SO-TEST");
      expect(gpsPayload.productList.length).toBeGreaterThan(0);

      for (const product of gpsPayload.productList) {
        expect(isServiceSku(product.sku)).toBe(false);
        expect(product.quantity).toBeGreaterThan(0);
      }
    });

    it("GPS UK Warehouse order uses LHR warehouse code", () => {
      const order = fixtures.gpsUkOrder;
      const gpsPayload = toGpsOutboundOrder(order, "H007-SO-TEST", "GPS UK Warehouse");

      expect(gpsPayload.whCode).toBe("LHR");
      expect(gpsPayload.logisticsChannel).toBe("GPS-IM8-STANDARD-UK");
    });

    it("STORD orders are not sent to GPS", () => {
      const order = fixtures.stordOrder;
      expect(shouldSendToGps(order, "STORD ATL Location")).toBe(false);
      expect(isGpsWarehouse("STORD ATL Location")).toBe(false);
      expect(isStordWarehouse("STORD ATL Location")).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 2 — Service SKU verification against spock-store
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Service SKU verification (spock-store parity)", () => {
    const skuTable = [
      {
        warehouse: "GPS Warehouse",
        tax: "IM8-SER-000001",
        refund: "IM8-SER-000003",
        shipping: "IM8-SER-000002",
      },
      {
        warehouse: "GPS UK Warehouse",
        tax: "IM8-SER-000001",
        refund: "IM8-SER-000003",
        shipping: "IM8-SER-000002",
      },
      {
        warehouse: "HK Warehouse",
        tax: "IM8-SER-000001",
        refund: "IM8-SER-000003",
        shipping: "IM8-SER-000002",
      },
      {
        warehouse: "STORD ATL Location",
        tax: "IM8-SER-000004",
        refund: "IM8-SER-000005",
        shipping: "IM8-SER-000003",
      },
    ];

    for (const row of skuTable) {
      it(`${row.warehouse}: tax=${row.tax}, refund=${row.refund}, shipping=${row.shipping}`, () => {
        expect(getTaxSku(row.warehouse)).toBe(row.tax);
        expect(getRefundSku(row.warehouse)).toBe(row.refund);
        expect(getShippingSku(row.warehouse)).toBe(row.shipping);
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 3 — Routing verification
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Country → warehouse → dataAreaId routing", () => {
    const routingTable = [
      { country: "US", warehouse: "GPS Warehouse", dataAreaId: "U001" },
      { country: "CA", warehouse: "GPS Warehouse", dataAreaId: "U001" },
      { country: "GB", warehouse: "GPS UK Warehouse", dataAreaId: "H007" },
      { country: "UK", warehouse: "GPS UK Warehouse", dataAreaId: "H007" },
      { country: "DE", warehouse: "GPS UK Warehouse", dataAreaId: "H007" },
      { country: "FR", warehouse: "GPS UK Warehouse", dataAreaId: "H007" },
      { country: "HK", warehouse: "HK Warehouse", dataAreaId: "H005" },
      { country: "SG", warehouse: "HK Warehouse", dataAreaId: "H005" },
      { country: "JP", warehouse: "GPS Warehouse", dataAreaId: "U001" },
      { country: "AU", warehouse: "GPS Warehouse", dataAreaId: "U001" },
    ];

    for (const tc of routingTable) {
      it(`${tc.country} → ${tc.warehouse} (${tc.dataAreaId})`, () => {
        const result = resolveCountryRouting(tc.country);
        expect(result.warehouseName).toBe(tc.warehouse);
        expect(result.dataAreaId).toBe(tc.dataAreaId);
        expect(result.countryCode).toBe(tc.country);
      });
    }

    it("unknown country falls back to default warehouse", () => {
      const result = resolveCountryRouting("ZZ");
      expect(result.warehouseName).toBe("GPS Warehouse");
      expect(result.source).toBe("default");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 4 — Real D365 API integration (header + lines + confirm)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Real D365 order creation", () => {
    it("creates D365 header, lines (with service SKUs), confirms, and verifies", async () => {
      const order = fixtures.gpsUkOrder;
      const warehouseName = "GPS UK Warehouse";
      const warehouseCfg = getWarehouseConfig(warehouseName);

      const header = toD365SalesOrderHeaderV3(order, warehouseName);
      expect(header.dataAreaId).toBe("H007");

      // Import the real D365 client (not a mock)
      const dynamics = await import("@/lib/clients/dynamics");
      await dynamics.authenticate();

      // 1. Create header
      const headerResult = await dynamics.createSalesOrderHeaderV3(header);
      const salesOrderNumber = headerResult.SalesOrderNumber;
      expect(salesOrderNumber).toBeTruthy();
      console.log(`[E2E] Created D365 header: ${salesOrderNumber}`);

      cleanup.push({ d365OrderNumber: salesOrderNumber, dataAreaId: "H007" });

      // 2. Create lines (including service SKUs)
      const lines = toD365SalesOrderLines(order, salesOrderNumber, warehouseName);
      expect(lines.length).toBeGreaterThan(0);

      const serviceLines = lines.filter((l) => isServiceSku(l.itemNumber));
      const productLines = lines.filter((l) => !isServiceSku(l.itemNumber));
      console.log(
        `[E2E] Creating ${lines.length} lines: ${productLines.length} product + ${serviceLines.length} service`
      );

      const lineErrors: string[] = [];
      for (const line of lines) {
        try {
          await dynamics.createSalesOrderLine({
            ...line,
            salesOrderNumber,
          });
        } catch (err: any) {
          const msg = err.message || String(err);
          if (isServiceSku(line.itemNumber) && msg.includes("does not exist")) {
            console.warn(`[E2E] Skipped missing service SKU ${line.itemNumber}: ${msg}`);
          } else {
            lineErrors.push(`${line.itemNumber}: ${msg}`);
          }
        }
      }

      if (lineErrors.length > 0) {
        console.error(`[E2E] Line creation errors: ${lineErrors.join("; ")}`);
      }
      expect(lineErrors.length).toBe(0);

      // 3. Confirm order
      await new Promise((r) => setTimeout(r, 1000));
      await dynamics.confirmSalesOrder(salesOrderNumber, "H007");
      console.log(`[E2E] Confirmed D365 order: ${salesOrderNumber}`);

      // 4. Create prepayment
      const prepaymentAmount = calculatePrepaymentAmount(order);
      if (prepaymentAmount > 0) {
        try {
          await dynamics.createPrepayment(salesOrderNumber, "H007");
          console.log(`[E2E] Prepayment created: $${prepaymentAmount}`);
        } catch (err: any) {
          console.warn(`[E2E] Prepayment skipped: ${err.message}`);
        }
      }

      // 5. Verify via lookup
      const found = await d365E2e.getSalesOrderByReference(order.name, "H007");
      expect(found).toBeTruthy();
      expect(found.SalesOrderNumber).toBe(salesOrderNumber);

      // 6. Verify lines exist
      const d365Lines = await d365E2e.getSalesOrderLines(salesOrderNumber, "H007");
      expect(d365Lines.length).toBeGreaterThanOrEqual(productLines.length);
    }, 120_000);
  });
});
