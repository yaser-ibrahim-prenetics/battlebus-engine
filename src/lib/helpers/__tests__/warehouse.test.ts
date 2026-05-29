import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  isGpsWarehouse,
  isGpsUkWarehouse,
  isStordWarehouse,
  getWarehouseConfig,
  isKnownWarehouseName,
  getWarehouseConfigForDataAreaId,
  getDefaultWarehouse,
  getDataAreaId,
  getOrderingCustomerAccountNumber,
  getOrderingCustomerAccountNumberByDataAreaId,
  toDefaultLedgerDimensionDisplayValue,
  toDefaultLedgerDimensionDisplayValueByDataArea,
  determineWarehouse,
  resolveRefundFulfillmentWarehouse,
  resolveCountryRouting,
  getGpsWarehouseCode,
  getGpsLogisticsChannel,
  getShippingSku,
  getTaxSku,
  getRefundSku,
  resolveRefundSkuAudit,
  getServiceSkuEnvProfile,
  getServiceSkuOverrideKind,
  getServiceSkuOverridesByDataArea,
  DEFAULT_D365_SERVICE_SKU_JSON_UAT,
  DEFAULT_D365_SERVICE_SKU_JSON_PROD,
  getFulfilmentConfig,
  getReturnConfig,
  shouldSkipFulfilmentNotification,
  isValidGpsWarehouse,
} from "../warehouse";

describe("Warehouse Routing Helpers", () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  describe("Warehouse Detection", () => {
    describe("isGpsWarehouse", () => {
      it("returns true for GPS Warehouse", () => {
        expect(isGpsWarehouse("GPS Warehouse")).toBe(true);
      });

      it("returns true for GPS UK Warehouse", () => {
        expect(isGpsWarehouse("GPS UK Warehouse")).toBe(true);
      });

      it("returns false for STORD", () => {
        expect(isGpsWarehouse("STORD ATL Location")).toBe(false);
      });

      it("returns false for HK Warehouse", () => {
        expect(isGpsWarehouse("HK Warehouse")).toBe(false);
      });
    });

    describe("isGpsUkWarehouse", () => {
      it("returns true only for GPS UK Warehouse", () => {
        expect(isGpsUkWarehouse("GPS UK Warehouse")).toBe(true);
        expect(isGpsUkWarehouse("GPS Warehouse")).toBe(false);
      });
    });

    describe("isStordWarehouse", () => {
      it("returns true for STORD ATL Location", () => {
        expect(isStordWarehouse("STORD ATL Location")).toBe(true);
      });

      it("returns false for GPS", () => {
        expect(isStordWarehouse("GPS Warehouse")).toBe(false);
      });
    });

    describe("isKnownWarehouseName", () => {
      it("validates known warehouses", () => {
        expect(isKnownWarehouseName("GPS Warehouse")).toBe(true);
        expect(isKnownWarehouseName("GPS UK Warehouse")).toBe(true);
        expect(isKnownWarehouseName("HK Warehouse")).toBe(true);
        expect(isKnownWarehouseName("STORD ATL Location")).toBe(true);
      });

      it("rejects unknown warehouses", () => {
        expect(isKnownWarehouseName("Nonexistent Warehouse")).toBe(false);
      });
    });

    describe("isValidGpsWarehouse", () => {
      it("validates GPS Warehouse and GPS UK Warehouse", () => {
        expect(isValidGpsWarehouse("GPS Warehouse")).toBe(true);
        expect(isValidGpsWarehouse("GPS UK Warehouse")).toBe(true);
        expect(isValidGpsWarehouse("HK Warehouse")).toBe(false);
      });
    });
  });

  describe("getWarehouseConfig", () => {
    it("returns config for GPS Warehouse", () => {
      const cfg = getWarehouseConfig("GPS Warehouse");
      expect(cfg.dataAreaId).toBe("U001");
      expect(cfg.gpsCode).toBe("JFK01W");
      expect(cfg.logisticsChannel).toBe("GPS-IM8-STANDARD");
    });

    it("returns config for GPS UK Warehouse", () => {
      const cfg = getWarehouseConfig("GPS UK Warehouse");
      expect(cfg.dataAreaId).toBe("H007");
      expect(cfg.gpsCode).toBe("LHR");
    });

    it("returns config for HK Warehouse", () => {
      const cfg = getWarehouseConfig("HK Warehouse");
      expect(cfg.dataAreaId).toBe("H007");
    });

    it("returns config for STORD ATL Location", () => {
      const cfg = getWarehouseConfig("STORD ATL Location");
      expect(cfg.dataAreaId).toBe("U001");
    });

    it("throws for unknown warehouse", () => {
      expect(() => getWarehouseConfig("Fake Warehouse")).toThrow("Unknown warehouse");
    });
  });

  describe("getWarehouseConfigForDataAreaId", () => {
    it("returns GPS Warehouse for U001", () => {
      const cfg = getWarehouseConfigForDataAreaId("U001");
      expect(cfg.name).toBe("GPS Warehouse");
    });

    it("returns GPS UK Warehouse for H007", () => {
      const cfg = getWarehouseConfigForDataAreaId("H007");
      expect(cfg.name).toBe("GPS UK Warehouse");
    });

    it("returns HK Warehouse for H005", () => {
      const cfg = getWarehouseConfigForDataAreaId("H005");
      expect(cfg.name).toBe("HK Warehouse");
    });

    it("is case-insensitive", () => {
      const cfg = getWarehouseConfigForDataAreaId("u001");
      expect(cfg.dataAreaId).toBe("U001");
    });

    it("throws for unknown dataAreaId", () => {
      expect(() => getWarehouseConfigForDataAreaId("ZZZZ")).toThrow("No warehouse profile found");
    });
  });

  describe("getDefaultWarehouse", () => {
    it("returns GPS Warehouse as default", () => {
      const cfg = getDefaultWarehouse();
      expect(cfg.name).toBe("GPS Warehouse");
    });
  });

  describe("Data Area Functions", () => {
    it("getDataAreaId returns correct IDs", () => {
      expect(getDataAreaId("GPS Warehouse")).toBe("U001");
      expect(getDataAreaId("GPS UK Warehouse")).toBe("H007");
      expect(getDataAreaId("HK Warehouse")).toBe("H007");
    });

    it("getOrderingCustomerAccountNumber returns correct accounts", () => {
      expect(getOrderingCustomerAccountNumber("GPS Warehouse")).toBe("U001-C000000006");
      expect(getOrderingCustomerAccountNumber("GPS UK Warehouse")).toBe("H007-C000000001");
      expect(getOrderingCustomerAccountNumber("HK Warehouse")).toBe("H005-C000000001");
    });

    it("getOrderingCustomerAccountNumberByDataAreaId derives correctly", () => {
      expect(getOrderingCustomerAccountNumberByDataAreaId("U001")).toBe("U001-C000000006");
      expect(getOrderingCustomerAccountNumberByDataAreaId("H007")).toBe("H007-C000000001");
      expect(getOrderingCustomerAccountNumberByDataAreaId("H005")).toBe("H005-C000000001");
    });
  });

  describe("Ledger Dimension", () => {
    it("toDefaultLedgerDimensionDisplayValue formats correctly", () => {
      const val = toDefaultLedgerDimensionDisplayValue("GPS Warehouse");
      expect(val).toBe("~Consumer - Nutrition~P1201~~U001-C000000006");
    });

    it("toDefaultLedgerDimensionDisplayValueByDataArea uses explicit dataAreaId", () => {
      const val = toDefaultLedgerDimensionDisplayValueByDataArea("GPS Warehouse", "H007");
      expect(val).toContain("H007-C000000001");
    });
  });

  describe("Country Routing", () => {
    describe("determineWarehouse", () => {
      it("routes US to GPS Warehouse", () => {
        expect(determineWarehouse("US")).toBe("GPS Warehouse");
      });

      it("routes GB to GPS UK Warehouse", () => {
        expect(determineWarehouse("GB")).toBe("GPS UK Warehouse");
      });

      it("routes UK alias to GPS UK Warehouse", () => {
        expect(determineWarehouse("UK")).toBe("GPS UK Warehouse");
      });

      it("routes HK to HK Warehouse", () => {
        expect(determineWarehouse("HK")).toBe("HK Warehouse");
      });

      it("routes EU countries to GPS UK Warehouse", () => {
        const euCountries = ["FR", "DE", "IT", "ES", "NL", "BE", "AT", "PT", "PL", "SE", "DK"];
        for (const cc of euCountries) {
          expect(determineWarehouse(cc)).toBe("GPS UK Warehouse");
        }
      });

      it("routes APAC countries to correct warehouses", () => {
        expect(determineWarehouse("SG")).toBe("HK Warehouse");
        expect(determineWarehouse("JP")).toBe("GPS Warehouse");
        expect(determineWarehouse("AU")).toBe("GPS Warehouse");
      });

      it("falls back to default for unknown country", () => {
        expect(determineWarehouse("ZZ")).toBe("GPS Warehouse");
      });

      it("is case-insensitive", () => {
        expect(determineWarehouse("us")).toBe("GPS Warehouse");
        expect(determineWarehouse("gb")).toBe("GPS UK Warehouse");
      });
    });

    describe("resolveCountryRouting", () => {
      it("returns full routing result for US", () => {
        const result = resolveCountryRouting("US");
        expect(result.warehouseName).toBe("GPS Warehouse");
        expect(result.dataAreaId).toBe("U001");
        expect(result.countryCode).toBe("US");
        expect(result.source).toBe("country_config");
      });

      it("returns default source for unknown country", () => {
        const result = resolveCountryRouting("ZZ");
        expect(result.source).toBe("default");
      });
    });

    describe("resolveRefundFulfillmentWarehouse", () => {
      it("prefers Hub STORD label on US shipments (GPS and STORD share U001)", () => {
        expect(resolveRefundFulfillmentWarehouse("US", "STORD ATL Location")).toBe(
          "STORD ATL Location"
        );
      });

      it("ignores unknown Hub labels and uses country routing", () => {
        expect(resolveRefundFulfillmentWarehouse("US", "Custom 3PL")).toBe("GPS Warehouse");
      });

      it("uses country routing when Hub warehouse is absent", () => {
        expect(resolveRefundFulfillmentWarehouse("GB", null)).toBe("GPS UK Warehouse");
      });

      it("STORD hub + GB still resolves refund profile via warehouse + dataArea", () => {
        const w = resolveRefundFulfillmentWarehouse("GB", "STORD EU Location");
        expect(w).toBe("STORD EU Location");
        expect(getRefundSku(w, "H007")).toBe("IM8-SER-000005");
      });
    });
  });

  describe("GPS-specific Functions", () => {
    it("getGpsWarehouseCode returns correct codes", () => {
      expect(getGpsWarehouseCode("GPS Warehouse")).toBe("JFK01W");
      expect(getGpsWarehouseCode("GPS UK Warehouse")).toBe("LHR");
    });

    it("getGpsWarehouseCode throws for non-GPS warehouse", () => {
      expect(() => getGpsWarehouseCode("HK Warehouse")).toThrow("not a GPS warehouse");
    });

    it("getGpsLogisticsChannel returns correct channels", () => {
      expect(getGpsLogisticsChannel("GPS Warehouse")).toBe("GPS-IM8-STANDARD");
      expect(getGpsLogisticsChannel("GPS UK Warehouse")).toBe("GPS-IM8-STANDARD-UK");
    });
  });

  describe("Service SKU Helpers", () => {
    beforeEach(() => {
      delete process.env.D365_SERVICE_SKU_BY_DATA_AREA_JSON_UAT;
      delete process.env.D365_SERVICE_SKU_BY_DATA_AREA_JSON_PROD;
      process.env.SHOPIFY_STORE_MODE = "production";
    });

    it("getShippingSku returns correct SKU per warehouse", () => {
      expect(getShippingSku("GPS Warehouse")).toBe("IM8-SER-000002");
      expect(getShippingSku("GPS UK Warehouse")).toBe("IM8-SER-000002");
      expect(getShippingSku("HK Warehouse")).toBe("IM8-SER-000002");
      expect(getShippingSku("STORD ATL Location")).toBe("IM8-SER-000002");
    });

    it("getTaxSku returns correct SKU per warehouse (PROD defaults for U001/H007)", () => {
      expect(getTaxSku("GPS Warehouse")).toBe("IM8-SER-000001");
      expect(getTaxSku("GPS UK Warehouse")).toBe("IM8-SER-000001");
      expect(getTaxSku("HK Warehouse")).toBe("IM8-SER-000001");
      expect(getTaxSku("STORD ATL Location")).toBe("IM8-SER-000001");
    });

    it("getRefundSku uses PROD defaults when SHOPIFY_STORE_MODE=production and env unset", () => {
      expect(getRefundSku("GPS Warehouse")).toBe("IM8-SER-000003");
      expect(getRefundSku("GPS UK Warehouse")).toBe("IM8-SER-000003");
      expect(getRefundSku("HK Warehouse")).toBe("IM8-SER-000003");
      expect(getRefundSku("STORD ATL Location")).toBe("IM8-SER-000003");
    });

    it("getRefundSku uses UAT defaults when SHOPIFY_STORE_MODE=test and env unset", () => {
      process.env.SHOPIFY_STORE_MODE = "test";

      expect(getRefundSku("GPS Warehouse")).toBe("IM8-SER-000005");
      expect(getTaxSku("GPS Warehouse")).toBe("IM8-SER-000004");
      expect(getShippingSku("GPS Warehouse")).toBe("IM8-SER-000003");
      expect(getRefundSku("STORD ATL Location")).toBe("IM8-SER-000005");
    });

    it("getServiceSkuEnvProfile follows SHOPIFY_STORE_MODE", () => {
      process.env.SHOPIFY_STORE_MODE = "test";
      expect(getServiceSkuEnvProfile()).toBe("UAT");
      process.env.SHOPIFY_STORE_MODE = "production";
      expect(getServiceSkuEnvProfile()).toBe("PROD");
    });

    it("default fallbacks match .env.local D365_SERVICE_SKU JSON (lines 8-9)", () => {
      const envLocalLine8 =
        '{"U001":{"tax":"IM8-SER-000004","refund":"IM8-SER-000005","shipping":"IM8-SER-000003"},"H007":{"tax":"IM8-SER-000001","refund":"IM8-SER-000005","shipping":"IM8-SER-000003"}}';
      const envLocalLine9 =
        '{"U001":{"tax":"IM8-SER-000001","refund":"IM8-SER-000003","shipping":"IM8-SER-000002"},"H007": {"tax":"IM8-SER-000001","refund":"IM8-SER-000003","shipping":"IM8-SER-000002"}}';

      expect(DEFAULT_D365_SERVICE_SKU_JSON_UAT).toBe(envLocalLine8);
      expect(DEFAULT_D365_SERVICE_SKU_JSON_PROD).toBe(envLocalLine9);

      delete process.env.D365_SERVICE_SKU_BY_DATA_AREA_JSON_UAT;
      delete process.env.D365_SERVICE_SKU_BY_DATA_AREA_JSON_PROD;

      process.env.SHOPIFY_STORE_MODE = "test";
      expect(getServiceSkuOverridesByDataArea()).toEqual({
        U001: {
          tax: "IM8-SER-000004",
          refund: "IM8-SER-000005",
          shipping: "IM8-SER-000003",
        },
        H007: {
          tax: "IM8-SER-000001",
          refund: "IM8-SER-000005",
          shipping: "IM8-SER-000003",
        },
      });

      process.env.SHOPIFY_STORE_MODE = "production";
      expect(getServiceSkuOverridesByDataArea()).toEqual({
        U001: {
          tax: "IM8-SER-000001",
          refund: "IM8-SER-000003",
          shipping: "IM8-SER-000002",
        },
        H007: {
          tax: "IM8-SER-000001",
          refund: "IM8-SER-000003",
          shipping: "IM8-SER-000002",
        },
      });
    });

    it("getRefundSku uses D365_SERVICE_SKU_BY_DATA_AREA_JSON_UAT when SHOPIFY_STORE_MODE=test", () => {
      process.env.SHOPIFY_STORE_MODE = "test";
      process.env.D365_SERVICE_SKU_BY_DATA_AREA_JSON_UAT = JSON.stringify({
        U001: {
          tax: "IM8-SER-000004",
          refund: "IM8-SER-000005",
          shipping: "IM8-SER-000003",
        },
        H007: {
          tax: "IM8-SER-000001",
          refund: "IM8-SER-000005",
          shipping: "IM8-SER-000003",
        },
      });

      expect(getRefundSku("GPS Warehouse", "U001")).toBe("IM8-SER-000005");
      expect(getShippingSku("GPS Warehouse", "U001")).toBe("IM8-SER-000003");
      expect(getRefundSku("HK Warehouse", "H007")).toBe("IM8-SER-000005");
      expect(getShippingSku("HK Warehouse", "H007")).toBe("IM8-SER-000003");
    });

    it("resolves SKU profile by routed dataAreaId when provided", () => {
      expect(getTaxSku("Some Custom Location", "H007")).toBe("IM8-SER-000001");
      expect(getRefundSku("Some Custom Location", "H007")).toBe("IM8-SER-000003");
      expect(getShippingSku("Some Custom Location", "H007")).toBe("IM8-SER-000002");
    });

    it("resolveRefundSkuAudit reports env_json_override when UAT JSON is set", () => {
      process.env.SHOPIFY_STORE_MODE = "test";
      process.env.D365_SERVICE_SKU_BY_DATA_AREA_JSON_UAT = JSON.stringify({
        U001: {
          tax: "UAT-TAX",
          refund: "UAT-REFUND-FROM-ENV",
          shipping: "UAT-SHIP",
        },
      });

      const audit = resolveRefundSkuAudit("GPS UK Warehouse", "U001");
      expect(audit.refundSku).toBe("UAT-REFUND-FROM-ENV");
      expect(audit.source).toBe("env_json_override");
      expect(audit.overrideKind).toBe("env");
      expect(audit.envVarName).toBe("D365_SERVICE_SKU_BY_DATA_AREA_JSON_UAT");
      expect(audit.envProfile).toBe("UAT");
      expect(audit.envRefundSku).toBe("UAT-REFUND-FROM-ENV");
      expect(audit.warehouseConfigRefund).toBe("IM8-SER-000003");
    });

    it("resolveRefundSkuAudit uses profile_default when env unset", () => {
      process.env.SHOPIFY_STORE_MODE = "production";

      const audit = resolveRefundSkuAudit("STORD ATL Location", "U001");
      expect(audit.refundSku).toBe("IM8-SER-000003");
      expect(audit.source).toBe("profile_default");
      expect(audit.overrideKind).toBe("default");
      expect(audit.envVarName).toBe("D365_SERVICE_SKU_BY_DATA_AREA_JSON_PROD");
    });

    it("resolveRefundSkuAudit throws when env JSON is set but dataArea refund is missing", () => {
      process.env.SHOPIFY_STORE_MODE = "production";
      process.env.D365_SERVICE_SKU_BY_DATA_AREA_JSON_PROD = JSON.stringify({
        U001: { tax: "ONLY-TAX", shipping: "ONLY-SHIP" },
      });

      expect(() => resolveRefundSkuAudit("GPS Warehouse", "U001")).toThrow(
        /must define JSON "U001\.refund"/
      );
    });

    it("uses UAT env when SHOPIFY_STORE_MODE=test even if PROD env is also set", () => {
      process.env.SHOPIFY_STORE_MODE = "test";
      process.env.D365_SERVICE_SKU_BY_DATA_AREA_JSON_UAT = JSON.stringify({
        U001: {
          tax: "UAT-TAX-SKU-2",
          refund: "UAT-REFUND-SKU-2",
          shipping: "UAT-SHIPPING-SKU-2",
        },
      });
      process.env.D365_SERVICE_SKU_BY_DATA_AREA_JSON_PROD = JSON.stringify({
        U001: {
          tax: "PROD-TAX-SKU",
          refund: "PROD-REFUND-SKU",
          shipping: "PROD-SHIPPING-SKU",
        },
      });

      expect(getTaxSku("GPS Warehouse")).toBe("UAT-TAX-SKU-2");
      expect(getRefundSku("GPS Warehouse")).toBe("UAT-REFUND-SKU-2");
      expect(getShippingSku("GPS Warehouse")).toBe("UAT-SHIPPING-SKU-2");
    });

    it("parses double-encoded JSON env values", () => {
      const inner = {
        U001: {
          tax: "ENC-TAX",
          refund: "ENC-REFUND",
          shipping: "ENC-SHIP",
        },
      };
      process.env.D365_SERVICE_SKU_BY_DATA_AREA_JSON_PROD = JSON.stringify(JSON.stringify(inner));

      expect(getTaxSku("GPS Warehouse")).toBe("ENC-TAX");
      expect(getRefundSku("GPS Warehouse")).toBe("ENC-REFUND");
      expect(getShippingSku("GPS Warehouse")).toBe("ENC-SHIP");
    });

    it("parses env value wrapped in outer single quotes (invalid JSON first pass)", () => {
      const body = JSON.stringify({
        U001: {
          tax: "WRAP-TAX",
          refund: "WRAP-REFUND",
          shipping: "WRAP-SHIP",
        },
      });
      process.env.D365_SERVICE_SKU_BY_DATA_AREA_JSON_PROD = `'${body}'`;

      expect(getTaxSku("GPS Warehouse")).toBe("WRAP-TAX");
      expect(getShippingSku("GPS Warehouse")).toBe("WRAP-SHIP");
    });

    it("logs error and uses UAT defaults when D365_SERVICE_SKU_BY_DATA_AREA_JSON_UAT is invalid", () => {
      process.env.SHOPIFY_STORE_MODE = "test";
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      process.env.D365_SERVICE_SKU_BY_DATA_AREA_JSON_UAT = "{not-valid-json";

      expect(getRefundSku("GPS Warehouse")).toBe("IM8-SER-000005");
      expect(getServiceSkuOverrideKind()).toBe("default");
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Error reading D365_SERVICE_SKU_BY_DATA_AREA_JSON_UAT")
      );

      errorSpy.mockRestore();
    });

    it("logs error and uses PROD defaults when D365_SERVICE_SKU_BY_DATA_AREA_JSON_PROD is invalid", () => {
      process.env.SHOPIFY_STORE_MODE = "production";
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      process.env.D365_SERVICE_SKU_BY_DATA_AREA_JSON_PROD = "[]";

      expect(getRefundSku("GPS Warehouse")).toBe("IM8-SER-000003");
      expect(getServiceSkuOverrideKind()).toBe("default");
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Error reading D365_SERVICE_SKU_BY_DATA_AREA_JSON_PROD")
      );

      errorSpy.mockRestore();
    });
  });

  describe("Fulfilment / Return Helpers", () => {
    it("getFulfilmentConfig returns correct config", () => {
      const fc = getFulfilmentConfig("GPS Warehouse");
      expect(fc.shippingSiteId).toBe("Prenetics");
      expect(fc.shippingWarehouseId).toBe("USOPS-WH04");
    });

    it("getReturnConfig returns correct config", () => {
      const rc = getReturnConfig("GPS Warehouse");
      expect(rc.shippingWarehouseLocationId).toBe("Return");
    });

    it("shouldSkipFulfilmentNotification for GPS UK only", () => {
      expect(shouldSkipFulfilmentNotification("GPS UK Warehouse")).toBe(true);
      expect(shouldSkipFulfilmentNotification("GPS Warehouse")).toBe(false);
    });
  });
});
