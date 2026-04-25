import { describe, it, expect, beforeEach } from "vitest";
import {
  mapShopifySkuToDynamics,
  mapShopifySkuToDynamicsForOrderLine,
  mapDynamicsSkuToShopify,
  getShopifyToDynamicsMapping,
  getDynamicsToShopifyMapping,
  getRefillMapping,
  getRewardMapping,
  createShopifyToDynamicsLineTransformer,
  mergeGpsDuplicateSkuLines,
  isServiceSku,
  filterServiceSkus,
  isDummySku,
  filterDummySkus,
  explodeBundleLines,
  isBundleSku,
  getBundleComponents,
  resetBundleCache,
} from "../sku";

describe("SKU Transformers", () => {
  beforeEach(() => {
    resetBundleCache();
  });

  describe("mapShopifySkuToDynamics (refill+merge loop)", () => {
    it("applies refill mapping when it exists", () => {
      // IM8-FG-000010 -> IM8-FG-000035 (refill mapping)
      expect(mapShopifySkuToDynamics("IM8-FG-000010")).toBe("IM8-FG-000035");
    });

    it("applies merge mapping when refill does not apply", () => {
      // IM8-FG-00096 -> IM8-FG-000096 (merge/zero-padding mapping)
      expect(mapShopifySkuToDynamics("IM8-FG-00096")).toBe("IM8-FG-000096");
    });

    it("returns original SKU when no mapping exists", () => {
      expect(mapShopifySkuToDynamics("IM8-FG-999999")).toBe("IM8-FG-999999");
    });

    it("handles multiple refill mappings", () => {
      expect(mapShopifySkuToDynamics("IM8-FG-000030")).toBe("IM8-FG-000053");
      expect(mapShopifySkuToDynamics("IM8-FG-000011")).toBe("IM8-FG-000007");
      expect(mapShopifySkuToDynamics("IM8-FG-000012")).toBe("IM8-FG-000040");
      expect(mapShopifySkuToDynamics("IM8-FG-000031")).toBe("IM8-FG-000048");
    });

    it("chains merge then refill (merge target may be a refill key)", () => {
      // 076 --merge--> 010 --refill--> 035
      expect(mapShopifySkuToDynamics("IM8-FG-000076")).toBe("IM8-FG-000035");
      expect(mapShopifySkuToDynamics("IM8-FG-000171")).toBe("IM8-FG-000064");
      expect(mapShopifySkuToDynamics("PRE-FG-000127")).toBe("PRE-FG-000021");
    });

    it("resolves chained SKU swaps to final Dynamics SKU", () => {
      expect(mapShopifySkuToDynamics("IM8-FG-000078")).toBe("IM8-FG-000007");
      expect(mapShopifySkuToDynamics("IM8-FG-000082")).toBe("IM8-FG-000040");
    });
  });

  describe("mapShopifySkuToDynamicsForOrderLine (spock-store: merge only, one hop)", () => {
    it("applies a single merge lookup, no refill", () => {
      expect(mapShopifySkuToDynamicsForOrderLine("IM8-FG-000076")).toBe("IM8-FG-000010");
      expect(mapShopifySkuToDynamicsForOrderLine("IM8-FG-000078")).toBe("IM8-FG-000011");
      expect(mapShopifySkuToDynamicsForOrderLine("IM8-FG-000084")).toBe("IM8-FG-000031");
    });

    it("does not apply refill table (e.g. 000010 is not remapped to 000035 here)", () => {
      expect(mapShopifySkuToDynamicsForOrderLine("IM8-FG-000010")).toBe("IM8-FG-000010");
      expect(mapShopifySkuToDynamicsForOrderLine("IM8-FG-000031")).toBe("IM8-FG-000031");
    });

    it("applies same merge fixes as getShopifyToDynamicsMapping", () => {
      expect(mapShopifySkuToDynamicsForOrderLine("IM8-FG-00096")).toBe("IM8-FG-000096");
      expect(mapShopifySkuToDynamicsForOrderLine("PRE-FG-000127")).toBe("PRE-FG-000021");
    });
  });

  describe("mapDynamicsSkuToShopify", () => {
    it("reverse maps D365 SKU to Shopify SKU", () => {
      const result = mapDynamicsSkuToShopify("IM8-FG-000096");
      expect(result).toBe("IM8-FG-00096");
    });

    it("returns original when no reverse mapping exists", () => {
      expect(mapDynamicsSkuToShopify("UNKNOWN-SKU")).toBe("UNKNOWN-SKU");
    });

    it("prefers original Shopify SKU when provided", () => {
      expect(mapDynamicsSkuToShopify("IM8-FG-000096", "IM8-FG-00096")).toBe("IM8-FG-00096");
    });
  });

  describe("getShopifyToDynamicsMapping / getDynamicsToShopifyMapping", () => {
    it("returns merge mappings", () => {
      const mapping = getShopifyToDynamicsMapping();
      expect(mapping["IM8-FG-00096"]).toBe("IM8-FG-000096");
    });

    it("returns reverse merge mappings", () => {
      const reverse = getDynamicsToShopifyMapping();
      expect(reverse["IM8-FG-000096"]).toBe("IM8-FG-00096");
    });
  });

  describe("getRefillMapping / getRewardMapping", () => {
    it("returns refill mappings", () => {
      const refill = getRefillMapping();
      expect(refill["IM8-FG-000010"]).toBe("IM8-FG-000035");
    });

    it("returns reward mappings", () => {
      const reward = getRewardMapping();
      expect(reward["3"]).toBe("IM8-FG-000022");
    });
  });

  describe("createShopifyToDynamicsLineTransformer", () => {
    it("transforms line itemNumber through SKU mapping", () => {
      const transformer = createShopifyToDynamicsLineTransformer();
      const line = { itemNumber: "IM8-FG-00096", quantity: 1 };
      const result = transformer(line);

      expect(result.itemNumber).toBe("IM8-FG-000096");
      expect(result.quantity).toBe(1);
    });

    it("does not apply refill; merge-only (matches spock-store line transformer)", () => {
      const transformer = createShopifyToDynamicsLineTransformer();
      const line = { itemNumber: "IM8-FG-000031", quantity: 2 };
      const result = transformer(line);

      expect(result.itemNumber).toBe("IM8-FG-000031");
    });

    it("preserves extra properties on lines", () => {
      const transformer = createShopifyToDynamicsLineTransformer();
      const line = { itemNumber: "IM8-FG-999999", quantity: 3, price: 49.99 };
      const result = transformer(line);

      expect(result.price).toBe(49.99);
      expect(result.quantity).toBe(3);
    });
  });

  describe("mergeGpsDuplicateSkuLines", () => {
    it("merges lines with same SKU", () => {
      const lines = [
        { itemNumber: "IM8-FG-000031", quantity: 2 },
        { itemNumber: "IM8-FG-000035", quantity: 1 },
        { itemNumber: "IM8-FG-000031", quantity: 3 },
      ];
      const merged = mergeGpsDuplicateSkuLines(lines);

      expect(merged.length).toBe(2);
      const sku031 = merged.find((m) => m.sku === "IM8-FG-000031");
      expect(sku031?.quantity).toBe(5);
    });

    it("handles single line without merging", () => {
      const lines = [{ itemNumber: "IM8-FG-000031", quantity: 1 }];
      const merged = mergeGpsDuplicateSkuLines(lines);

      expect(merged.length).toBe(1);
      expect(merged[0].sku).toBe("IM8-FG-000031");
      expect(merged[0].quantity).toBe(1);
    });

    it("handles empty array", () => {
      expect(mergeGpsDuplicateSkuLines([]).length).toBe(0);
    });
  });

  describe("Service SKU Detection", () => {
    describe("isServiceSku", () => {
      it("detects IM8-SER- prefix", () => {
        expect(isServiceSku("IM8-SER-000001")).toBe(true);
        expect(isServiceSku("IM8-SER-000003")).toBe(true);
      });

      it("detects PRE-SER- prefix", () => {
        expect(isServiceSku("PRE-SER-000001")).toBe(true);
      });

      it("returns false for product SKUs", () => {
        expect(isServiceSku("IM8-FG-000031")).toBe(false);
        expect(isServiceSku("PRE-FG-000021")).toBe(false);
      });
    });

    describe("filterServiceSkus", () => {
      it("removes service SKUs from lines", () => {
        const lines = [
          { itemNumber: "IM8-FG-000031", quantity: 1 },
          { itemNumber: "IM8-SER-000001", quantity: 1 },
          { itemNumber: "IM8-FG-000035", quantity: 2 },
        ];
        const filtered = filterServiceSkus(lines);

        expect(filtered.length).toBe(2);
        expect(filtered.every((l) => !l.itemNumber.startsWith("IM8-SER-"))).toBe(true);
      });
    });
  });

  describe("Dummy SKU Detection", () => {
    describe("isDummySku", () => {
      it("detects IM8-FG-G pattern", () => {
        expect(isDummySku("IM8-FG-G00001")).toBe(true);
        expect(isDummySku("im8-fg-g00001")).toBe(true);
      });

      it("returns false for normal product SKUs", () => {
        expect(isDummySku("IM8-FG-000031")).toBe(false);
      });
    });

    describe("filterDummySkus", () => {
      it("removes dummy SKUs from lines", () => {
        const lines = [
          { itemNumber: "IM8-FG-000031", quantity: 1 },
          { itemNumber: "IM8-FG-G00001", quantity: 1 },
        ];
        const filtered = filterDummySkus(lines);

        expect(filtered.length).toBe(1);
        expect(filtered[0].itemNumber).toBe("IM8-FG-000031");
      });
    });
  });

  describe("Bundle / Kit Explosion", () => {
    describe("explodeBundleLines", () => {
      it("passes through non-bundle lines unchanged", () => {
        const lines = [
          { itemNumber: "IM8-FG-000031", quantity: 1 },
          { itemNumber: "IM8-FG-000035", quantity: 2 },
        ];
        const exploded = explodeBundleLines(lines);

        expect(exploded.length).toBe(2);
        expect(exploded).toEqual(lines);
      });

      it("explodes bundle SKUs into components with correct quantities", () => {
        process.env.BUNDLE_SKU_OVERRIDES = JSON.stringify({
          "BUNDLE-TEST": [
            { sku: "COMP-A", quantity: 2 },
            { sku: "COMP-B", quantity: 1 },
          ],
        });
        resetBundleCache();

        const lines = [{ itemNumber: "BUNDLE-TEST", quantity: 3 }];
        const exploded = explodeBundleLines(lines);

        expect(exploded.length).toBe(2);
        expect(exploded[0].itemNumber).toBe("COMP-A");
        expect(exploded[0].quantity).toBe(6); // 3 * 2
        expect(exploded[1].itemNumber).toBe("COMP-B");
        expect(exploded[1].quantity).toBe(3); // 3 * 1

        delete process.env.BUNDLE_SKU_OVERRIDES;
        resetBundleCache();
      });
    });

    describe("isBundleSku / getBundleComponents", () => {
      it("returns false for non-bundle SKU", () => {
        expect(isBundleSku("IM8-FG-000031")).toBe(false);
      });

      it("returns undefined components for non-bundle", () => {
        expect(getBundleComponents("IM8-FG-000031")).toBeUndefined();
      });

      it("detects env-override bundle", () => {
        process.env.BUNDLE_SKU_OVERRIDES = JSON.stringify({
          "MY-BUNDLE": [{ sku: "A", quantity: 1 }],
        });
        resetBundleCache();

        expect(isBundleSku("MY-BUNDLE")).toBe(true);
        expect(getBundleComponents("MY-BUNDLE")).toEqual([{ sku: "A", quantity: 1 }]);

        delete process.env.BUNDLE_SKU_OVERRIDES;
        resetBundleCache();
      });
    });
  });
});
