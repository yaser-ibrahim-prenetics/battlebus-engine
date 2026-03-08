// ============================================================================
// SHOPIFY LOCATIONS API (Battle Bus)
// ============================================================================
// Fetches all locations from Shopify API for location selection in fulfillment/refund
// Returns both configured locations (from env) and all available Shopify locations

import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";

interface ShopifyLocation {
  id: number;
  name: string;
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  country: string | null;
  zip: string | null;
  phone: string | null;
  active: boolean;
  legacy: boolean;
  localized_country_name: string | null;
  localized_province_name: string | null;
}

interface LocationResponse {
  locations: ShopifyLocation[];
  configured: {
    gps: { id: string; name: string } | null;
    gpsUk: { id: string; name: string } | null;
    stord: { id: string; name: string } | null;
    hkWarehouse: { id: string; name: string } | null;
  };
}

export async function GET(request: NextRequest) {
  try {
    const shopDomain = config.shopify.im8.shopDomain;
    const accessToken = config.shopify.im8.accessToken;
    const apiVersion = config.shopify.im8.apiVersion;

    if (!shopDomain || !accessToken) {
      return NextResponse.json(
        { error: "Shopify configuration missing in Battle Bus" },
        { status: 500 }
      );
    }

    // Fetch all locations from Shopify
    const response = await fetch(`https://${shopDomain}/admin/api/${apiVersion}/locations.json`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      console.error("[Shopify Locations] Failed to fetch:", error);
      return NextResponse.json(
        { error: "Failed to fetch Shopify locations", details: error },
        { status: response.status }
      );
    }

    const data = await response.json();
    const shopifyLocations: ShopifyLocation[] = data.locations || [];

    // Map configured location IDs to their names from the fetched locations
    const configuredLocations = config.shopify.im8.locations;
    const findLocationName = (id: string): string | null => {
      if (!id) return null;
      const location = shopifyLocations.find((loc) => loc.id.toString() === id);
      return location?.name || null;
    };

    const result: LocationResponse = {
      locations: shopifyLocations.filter((loc) => loc.active), // Only return active locations
      configured: {
        gps: configuredLocations.gps
          ? {
              id: configuredLocations.gps,
              name: findLocationName(configuredLocations.gps) || "GPS US Warehouse",
            }
          : null,
        gpsUk: configuredLocations.gpsUk
          ? {
              id: configuredLocations.gpsUk,
              name: findLocationName(configuredLocations.gpsUk) || "GPS UK Warehouse",
            }
          : null,
        stord: configuredLocations.stord
          ? {
              id: configuredLocations.stord,
              name: findLocationName(configuredLocations.stord) || "STORD Warehouse",
            }
          : null,
        hkWarehouse: configuredLocations.hkWarehouse
          ? {
              id: configuredLocations.hkWarehouse,
              name: findLocationName(configuredLocations.hkWarehouse) || "HK Warehouse",
            }
          : null,
      },
    };

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    console.error("[Shopify Locations] Error:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
