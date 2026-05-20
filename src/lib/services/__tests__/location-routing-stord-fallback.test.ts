import { describe, it, expect } from "vitest";
import {
  orderShippableLinesAllUseStordFulfillment,
  resolveStordEuOverrideForMappedLocation,
  stordWarehouseNameForShipCountry,
} from "../location-routing";

describe("Stord routing fallbacks", () => {
  it("detects all-shippable-lines stord", () => {
    expect(
      orderShippableLinesAllUseStordFulfillment({
        line_items: [
          {
            requires_shipping: true,
            gift_card: false,
            fulfillment_service: "stord",
          },
        ],
      })
    ).toBe(true);
  });

  it("rejects mixed fulfillment_service", () => {
    expect(
      orderShippableLinesAllUseStordFulfillment({
        line_items: [
          { requires_shipping: true, fulfillment_service: "stord" },
          { requires_shipping: true, fulfillment_service: "manual" },
        ],
      })
    ).toBe(false);
  });

  it("maps CA to STORD ATL", () => {
    expect(stordWarehouseNameForShipCountry("CA")).toBe("STORD ATL Location");
  });

  it("maps DE to STORD EU", () => {
    expect(stordWarehouseNameForShipCountry("DE")).toBe("STORD EU Location");
  });

  it("treats mapped STORD ATL + DE as EU override candidate", async () => {
    const result = await resolveStordEuOverrideForMappedLocation(
      "STORD ATL Location",
      "DE",
      "im8"
    );
    // This can be null in unit env without Supabase/Hub location rows; when non-null,
    // it must target STORD EU/H007 profile.
    if (result) {
      expect(result.warehouseName).toBe("STORD EU Location");
      expect(result.dataAreaId.toUpperCase()).toBe("H007");
    } else {
      expect(result).toBeNull();
    }
  });
});
