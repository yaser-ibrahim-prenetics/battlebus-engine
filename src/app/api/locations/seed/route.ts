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

// Location name is the warehouse. We only auto-detect a default dataAreaId for new rows.
function inferDataAreaId(loc: { name: string; country?: string | null }): string | null {
  const n = (loc.name || "").toLowerCase();
  if (n.includes("gps") && (n.includes("uk") || n.includes("london") || n.includes("lhr"))) return "H007";
  if (n.includes("gps")) return "U001";
  if (n.includes("stord")) return "U001";
  if (n.includes("hk") || n.includes("hong kong")) return "H005";
  if (loc.country) return resolveCountryRouting(loc.country).dataAreaId;
  return null;
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
      const dataAreaId = inferDataAreaId({ name: loc.name, country: loc.country ?? null });

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
        defaultWarehouseName: loc.name,
        defaultDataAreaId: dataAreaId,
        isCreate: false,
      });

      results.push({ id: loc.id, name: loc.name, status: "upserted", warehouseName: loc.name, dataAreaId });
      console.log(`[LocationSeed] Upserted "${loc.name}" (${loc.id}) → dataAreaId=${dataAreaId}`);
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
