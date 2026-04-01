import { describe, it, expect } from "vitest";
import {
  orderShippableLinesAllUseStordFulfillment,
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
});
