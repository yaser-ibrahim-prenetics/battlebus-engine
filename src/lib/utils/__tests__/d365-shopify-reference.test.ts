import { describe, expect, it } from "vitest";
import {
  parseDuplicateShopifyReferenceSalesOrderNumber,
  shopifyReferenceLookupCandidates,
} from "../d365-shopify-reference";

describe("d365-shopify-reference", () => {
  it("parses duplicate shopify reference sales order number from D365 error", () => {
    const error = JSON.stringify({
      error: {
        innererror: {
          message:
            "Write failed for table row of type 'SalesOrderHeaderV3Entity'. Infolog: Warning: The shopify reference IM8-22037 is already exist in sales order H007-SO-123916.; Warning: validateWrite failed on data source 'SalesTable (SalesTable)'.",
        },
      },
    });

    expect(parseDuplicateShopifyReferenceSalesOrderNumber(error)).toBe("H007-SO-123916");
  });

  it("builds shopify reference lookup candidates", () => {
    expect(shopifyReferenceLookupCandidates("IM8-22037", "7115025514728")).toEqual([
      "IM8-22037",
      "#IM8-22037",
      "7115025514728",
    ]);
  });
});
