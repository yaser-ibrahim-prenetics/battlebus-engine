// ============================================================================
// LOCATION SEED — pulls all Shopify locations and upserts into Supabase
// ============================================================================
// POST /api/locations/seed
//   Seeds (or refreshes) the Supabase `locations` table from the Shopify API.
//   Run this once after deployment, or any time locations are out of sync.
//   Safe to call repeatedly — existing routing config is never overwritten.
//
// GET /api/locations/seed
//   Returns the current locations from Supabase (for inspection).

import { NextRequest, NextResponse } from "next/server";
import { getAllLocations } from "@/lib/clients/shopify";
import {
  upsertLocation,
  getLocationMappings,
  clearLocationCache,
} from "@/lib/services/location-routing";
import { resolveCountryRouting, getDataAreaId } from "@/lib/helpers/warehouse";

// ============================================================================
// Helpers (mirrors logic in process-location-sync.ts — no shared dep needed)
// ============================================================================

function inferWarehouseFromName(name: string): string | null {
  const n = (name || "").toLowerCase();
  if (n.includes("gps") && (n.includes("uk") || n.includes("london") || n.includes("lhr"))) {
    return "GPS UK Warehouse";
  }
  if (n.includes("gps")) return "GPS Warehouse";
  if (n.includes("stord")) return "STORD ATL Location";
  if (n.includes("hk") || n.includes("hong kong")) return "HK Warehouse";
  return null;
}

function autoDetect(loc: { name: string; country?: string | null }) {
  const byName = inferWarehouseFromName(loc.name);
  const warehouseName = byName ?? (loc.country ? resolveCountryRouting(loc.country).warehouseName : null);
  let dataAreaId: string | null = null;
  if (warehouseName) {
    try {
      dataAreaId = getDataAreaId(warehouseName);
    } catch {
      dataAreaId = null;
    }
  }
  return { warehouseName, dataAreaId };
}

// ============================================================================
// GET — inspect current locations in Supabase
// ============================================================================

export async function GET() {
  try {
    const mappings = await getLocationMappings(true);
    return NextResponse.json({
      count: mappings.length,
      locations: mappings.map((m) => ({
        id: m.id,
        name: m.name,
        shopifyLocationId: m.shopifyLocationId,
        warehouseName: m.warehouseName,
        dynamicsDataAreaId: m.dynamicsDataAreaId,
        countryDataAreaMapping: m.countryDataAreaMapping,
        active: m.active,
      })),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// ============================================================================
// POST — fetch from Shopify, upsert into Supabase
// ============================================================================

export async function POST(req: NextRequest) {
  // Simple auth check — must supply INNGEST_SIGNING_KEY or BATTLE_BUS_API_KEY header
  const apiKey =
    req.headers.get("x-api-key") ||
    req.headers.get("authorization")?.replace("Bearer ", "");
  const expectedKey =
    process.env.BATTLE_BUS_API_KEY || process.env.INNGEST_SIGNING_KEY;

  if (expectedKey && apiKey !== expectedKey) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    console.log("[LocationSeed] Fetching all locations from Shopify...");
    const shopifyLocations = await getAllLocations();
    console.log(`[LocationSeed] Found ${shopifyLocations.length} Shopify locations`);

    const results: Array<{
      id: string;
      name: string;
      status: "upserted";
      warehouseName: string | null;
      dataAreaId: string | null;
    }> = [];

    for (const loc of shopifyLocations) {
      const { warehouseName, dataAreaId } = autoDetect({
        name: loc.name,
        country: loc.country ?? null,
      });

      await upsertLocation({
        shopifyLocationId: loc.id,
        name: loc.name,
        addressLine1: loc.address1 ?? null,
        addressLine2: loc.address2 ?? null,
        city: loc.city ?? null,
        province: loc.province ?? null,
        country: loc.country ?? null,
        zip: loc.zip ?? null,
        phone: loc.phone ?? null,
        active: loc.active,
        fulfillmentServiceId: loc.fulfillment_service_id ?? null,
        defaultWarehouseName: warehouseName,
        defaultDataAreaId: dataAreaId,
        // isCreate=false so existing routing config is preserved on re-seed
        isCreate: false,
      });

      results.push({ id: loc.id, name: loc.name, status: "upserted", warehouseName, dataAreaId });
      console.log(
        `[LocationSeed] Upserted "${loc.name}" (${loc.id}) → ${warehouseName} / ${dataAreaId}`
      );
    }

    // Force routing cache refresh
    clearLocationCache();

    return NextResponse.json({
      seeded: results.length,
      locations: results,
      hint: "Routing config (warehouseName, dynamicsDataAreaId, country overrides) is preserved for existing rows. Configure in Battle Hub → Locations.",
    });
  } catch (err: any) {
    console.error("[LocationSeed] Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
