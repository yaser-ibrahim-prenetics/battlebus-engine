// ============================================================================
// ROUTING DEBUG ENDPOINT
// ============================================================================
// GET  /api/routing           — full country→warehouse→dataAreaId table
// GET  /api/routing?country=GB — resolve a single country code
// POST /api/routing            — test-resolve a batch of country codes
//
// This endpoint is read-only and contains no sensitive data.
// It reflects the active routing table including any COUNTRY_ROUTING_OVERRIDES.

import { NextRequest, NextResponse } from "next/server";
import { getActiveRoutingTable, resolveCountryRouting } from "@/lib/helpers/warehouse";

export async function GET(request: NextRequest) {
  const country = request.nextUrl.searchParams.get("country");

  if (country) {
    // Resolve a single country code
    const result = resolveCountryRouting(country.toUpperCase());
    return NextResponse.json({
      country: result.countryCode,
      warehouse: result.warehouseName,
      dataAreaId: result.dataAreaId,
      source: result.source,
    });
  }

  // Return the full active routing table
  const table = getActiveRoutingTable();
  return NextResponse.json({
    activeOverrides: Object.keys(table.overrides).length > 0 ? table.overrides : null,
    warehouses: table.warehouses,
    countryRouting: table.countryRouting,
    envVar: "COUNTRY_ROUTING_OVERRIDES",
    hint: 'Set COUNTRY_ROUTING_OVERRIDES env var to a JSON object to override per-country routing without a code change. E.g.: {"AU":"HK Warehouse"}',
  });
}

export async function POST(request: NextRequest) {
  // Batch-resolve multiple country codes for testing
  let body: { countries?: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { countries } = body;
  if (!Array.isArray(countries) || countries.length === 0) {
    return NextResponse.json(
      { error: "Provide a 'countries' array of ISO country codes" },
      { status: 400 }
    );
  }

  const results = countries.map((c) => {
    const r = resolveCountryRouting(String(c).toUpperCase());
    return {
      country: r.countryCode,
      warehouse: r.warehouseName,
      dataAreaId: r.dataAreaId,
      source: r.source,
    };
  });

  return NextResponse.json({ results });
}
