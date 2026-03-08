// ============================================================================
// ADDRESS TRANSFORMERS
// ============================================================================
// Ported from spock-store src/component/address.ts

import type { D365SalesOrderHeadersV3Address } from "../types/dynamics";
import type { ShopifyAddress } from "../../inngest/events";
import { getCountryISO3 } from "../helpers/country";

// ============================================================================
// GPS Address Type
// ============================================================================

export interface GpsAddress {
  receiver: string;
  addressOne: string;
  addressTwo: string;
  cityName: string;
  countryRegionCode: string;
  provinceName: string;
  provinceCode: string;
  postCode: string;
  telephone: string;
  email: string;
}

// ============================================================================
// D365 Address Transformer
// ============================================================================

/**
 * Transform Shopify address to D365 SalesOrderHeadersV3 address format
 * Ported from spock-store
 */
export function toSalesOrderHeadersV3Address(
  address: ShopifyAddress
): D365SalesOrderHeadersV3Address {
  return {
    addressCity: address.city,
    addressCountryCode: getCountryISO3(address.country_code),
    addressLine: address.address1 + (address.address2 ? ", " + address.address2 : ""),
    addressName: `${address.first_name} ${address.last_name}`.trim(),
    addressStateId: address.province_code ?? "",
    addressStreet: address.address1,
    addressZipCode: address.zip,
    addressPhone: address.phone ?? "",
  };
}

// ============================================================================
// GPS Address Transformer
// ============================================================================

/**
 * Transform Shopify address to GPS address format
 * Ported from spock-store - includes UAE/SA postal code handling
 */
export function toGpsOrderAddress(address: ShopifyAddress & { email: string }): GpsAddress {
  /**
   * UAE and Saudi Arabia do not have a postal code system like many other countries.
   * Use '00000' as a placeholder for UAE/Saudi Arabia addresses.
   * https://www.zipcode.com.ng/2022/10/united-arab-emirates-postcode.html
   */
  const getPostCode = (): string => {
    if (address.country_code === "AE" || address.country_code === "SA") {
      return "00000";
    }
    return address.zip || "";
  };

  return {
    receiver: `${address.first_name} ${address.last_name}`.trim(),
    addressOne: address.address1,
    addressTwo: address.address2 ?? "",
    cityName: address.city,
    countryRegionCode: address.country_code,
    provinceName: address.province ?? "",
    provinceCode: address.province_code ?? "",
    postCode: getPostCode(),
    telephone: address.phone ?? "",
    email: address.email ?? "",
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Format full address name from first and last name
 */
export function formatAddressName(address: ShopifyAddress | null): string {
  if (!address) return "";
  return `${address.first_name} ${address.last_name}`.trim();
}

/**
 * Format street address combining address1 and address2
 */
export function formatStreet(address: ShopifyAddress | null): string {
  if (!address) return "";
  return [address.address1, address.address2].filter(Boolean).join(", ");
}

/**
 * Format full address description
 */
export function formatAddressDescription(address: ShopifyAddress | null): string {
  if (!address) return "";
  return `${formatAddressName(address)}, ${formatStreet(address)}, ${address.city}`;
}
