import { describe, it, expect } from "vitest";
import { toSaudiGpsAddressLines } from "../saudi-gps-address";

describe("Saudi GPS address lines", () => {
  it.each([
    ["Street", "", "abcd1234", "Street", "ABCD1234"],
    ["Street", "District", "ABCD1234", "Street", "District ABCD1234"],
    ["ABCD1234, Street", "District", "ABCD1234", "Street", "District ABCD1234"],
    ["Street, abcd1234", "District ABCD1234", "ABCD1234", "Street", "District ABCD1234"],
    ["Street", "abcd1234, District", "ABCD1234", "Street", "District ABCD1234"],
    ["ABCD1234 Street", "", "", "Street", "ABCD1234"],
    ["Street", "District ABCD1234", "", "Street", "District ABCD1234"],
    ["Street", "District", "", "Street", "District"],
    ["ABCD1234 Street", "WXYZ9876 District", "", "ABCD1234 Street", "WXYZ9876 District"],
    ["Street", "District", "invalid", "Street", "District"],
    ["XABCD1234Y Street", "District", "ABCD1234", "XABCD1234Y Street", "District ABCD1234"],
  ])("maps %s / %s with %s", (address1, address2, code, addressOne, addressTwo) => {
    expect(toSaudiGpsAddressLines(address1, address2, code)).toEqual({ addressOne, addressTwo });
  });

  it("is stable when a normalized address is retried", () => {
    const first = toSaudiGpsAddressLines("ABCD1234 Street", "District ABCD1234", "ABCD1234");
    expect(toSaudiGpsAddressLines(first.addressOne, first.addressTwo, "ABCD1234")).toEqual(first);
  });

  it("preserves long address text without truncating the appended code", () => {
    const district = "District ".repeat(30).trim();
    expect(toSaudiGpsAddressLines("Street", district, "ABCD1234").addressTwo).toBe(
      `${district} ABCD1234`
    );
  });
});
