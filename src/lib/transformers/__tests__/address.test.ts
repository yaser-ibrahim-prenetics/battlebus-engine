import { describe, expect, it } from "vitest";

import type { ShopifyAddress } from "@/inngest/events";
import {
  getIm8ShortAddressFromMetafields,
  toGpsOrderAddress,
  toSalesOrderHeadersV3Address,
} from "../address";

const saudiAddress: ShopifyAddress = {
  first_name: "Aisha",
  last_name: "Al Saud",
  address1: ", 1234 King Fahd Road, ",
  address2: " 5678 Al Olaya, ",
  city: "Riyadh",
  province: "Riyadh",
  country: "Saudi Arabia",
  zip: "12345",
  phone: "+966501234567",
  company: null,
  country_code: "SA",
  province_code: "01",
};

describe("Saudi national short addresses", () => {
  it("extracts and normalizes the checkout-blocks metafield", () => {
    expect(
      getIm8ShortAddressFromMetafields([
        { namespace: "checkoutblocks", key: "short_address", value: " rjxa4321 " },
      ])
    ).toBe("RJXA4321");
    expect(
      getIm8ShortAddressFromMetafields([
        { namespace: "custom", key: "short_address", value: "RJXA4321" },
      ])
    ).toBe("");
  });

  it("prefixes the D365 address line", () => {
    const result = toSalesOrderHeadersV3Address(
      { ...saudiAddress, address1: "1234 King Fahd Road", address2: null },
      "rjxa4321"
    );
    expect(result.addressLine).toBe("RJXA4321, 1234 King Fahd Road");
  });

  it("trims GPS address edges and appends the code to Address2 with a space", () => {
    const result = toGpsOrderAddress({ ...saudiAddress, email: "aisha@example.com" }, "rjxa4321");
    expect(result.addressOne).toBe("1234 King Fahd Road");
    expect(result.addressTwo).toBe("5678 Al Olaya RJXA4321");
    expect(result.postCode).toBe("12345");
  });

  it("uses the GPS placeholder only when the Saudi postcode is absent", () => {
    const result = toGpsOrderAddress({ ...saudiAddress, zip: "", email: "a@example.com" });
    expect(result.postCode).toBe("00000");
  });
});

describe("GPS short-code separator contract", () => {
  it("uses a space in the ticket example", () => {
    const result = toGpsOrderAddress(
      { ...saudiAddress, address2: "Apt 4B", email: "a@example.com" },
      "RJXA4321"
    );
    expect(result.addressTwo).toBe("Apt 4B RJXA4321");
  });
  it("uses the code alone when Address2 is empty", () => {
    const result = toGpsOrderAddress(
      { ...saudiAddress, address2: null, email: "a@example.com" },
      "RJXA4321"
    );
    expect(result.addressOne).toBe("1234 King Fahd Road");
    expect(result.addressTwo).toBe("RJXA4321");
  });
  it.each(["AE", "US"])("preserves the existing %s mapping", (country_code) => {
    const address = { ...saudiAddress, country_code, email: "a@example.com" };
    const result = toGpsOrderAddress(address, "RJXA4321");
    expect(result.addressOne).toBe(address.address1);
    expect(result.addressTwo).toBe("5678 Al Olaya");
  });
});
