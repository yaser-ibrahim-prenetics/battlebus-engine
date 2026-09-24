// ============================================================================
// D365 INVENTORY LIST API (READ ONLY)
// ============================================================================
// Fetches inventory from D365 InventorySitesOnHandV2
// This is a READ ONLY operation - NO writes to D365
//
// Usage:
//   GET /api/inventory/d365
//   GET /api/inventory/d365?dataAreaId=u001
//   GET /api/inventory/d365?itemNumber=IM8-CON-000001
//   GET /api/inventory/d365?all=true (fetch all pages)

import { NextRequest, NextResponse } from "next/server";
import { getInventory, getAllInventory, type D365InventoryItem } from "@/lib/clients/dynamics";
import { requireServiceAuth } from "@/lib/auth/service-auth";

export async function GET(request: NextRequest) {
  const auth = requireServiceAuth(request);
  if (!auth.ok) {
    return NextResponse.json(auth.body, { status: auth.status });
  }

  try {
    const { searchParams } = new URL(request.url);

    const dataAreaId = searchParams.get("dataAreaId") || undefined;
    const itemNumber = searchParams.get("itemNumber") || undefined;
    const top = parseInt(searchParams.get("top") || "100", 10);
    const skip = parseInt(searchParams.get("skip") || "0", 10);
    const fetchAll = searchParams.get("all") === "true";

    let items: D365InventoryItem[];
    let pagination: { top: number; skip: number; count: number } | null = null;

    if (fetchAll) {
      // Fetch all pages
      items = await getAllInventory({ dataAreaId, itemNumber });
      pagination = {
        top: items.length,
        skip: 0,
        count: items.length,
      };
    } else {
      // Fetch single page
      const result = await getInventory({ dataAreaId, itemNumber, top, skip });
      items = result.items;
      pagination = {
        top,
        skip,
        count: result.count,
      };
    }

    // Aggregate by ItemNumber (sum across data areas)
    const aggregated = new Map<
      string,
      {
        itemNumber: string;
        productName: string;
        totalOnHand: number;
        totalAvailable: number;
        totalReserved: number;
        totalOrdered: number;
        dataAreas: Array<{
          dataAreaId: string;
          siteId: string;
          onHand: number;
          available: number;
          reserved: number;
          ordered: number;
        }>;
      }
    >();

    for (const item of items) {
      const existing = aggregated.get(item.ItemNumber);
      const dataAreaEntry = {
        dataAreaId: item.dataAreaId,
        siteId: item.InventorySiteId,
        onHand: item.OnHandQuantity,
        available: item.AvailableOnHandQuantity,
        reserved: item.ReservedOnHandQuantity,
        ordered: item.OrderedQuantity,
      };

      if (existing) {
        existing.totalOnHand += item.OnHandQuantity;
        existing.totalAvailable += item.AvailableOnHandQuantity;
        existing.totalReserved += item.ReservedOnHandQuantity;
        existing.totalOrdered += item.OrderedQuantity;
        existing.dataAreas.push(dataAreaEntry);
      } else {
        aggregated.set(item.ItemNumber, {
          itemNumber: item.ItemNumber,
          productName: item.ProductName,
          totalOnHand: item.OnHandQuantity,
          totalAvailable: item.AvailableOnHandQuantity,
          totalReserved: item.ReservedOnHandQuantity,
          totalOrdered: item.OrderedQuantity,
          dataAreas: [dataAreaEntry],
        });
      }
    }

    return NextResponse.json({
      success: true,
      source: "D365",
      pagination,
      filters: { dataAreaId, itemNumber },
      items: Array.from(aggregated.values()),
      raw: items, // Include raw response for debugging
    });
  } catch (error) {
    console.error("[D365 Inventory List] Error:", error);
    return NextResponse.json(
      {
        error: "Failed to fetch D365 inventory",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

// POST endpoint with same functionality
export async function POST(request: NextRequest) {
  const auth = requireServiceAuth(request);
  if (!auth.ok) {
    return NextResponse.json(auth.body, { status: auth.status });
  }

  try {
    const body = await request.json();

    const dataAreaId = body.dataAreaId || undefined;
    const itemNumber = body.itemNumber || undefined;
    const top = body.top || 100;
    const skip = body.skip || 0;
    const fetchAll = body.all === true;

    let items: D365InventoryItem[];

    if (fetchAll) {
      items = await getAllInventory({ dataAreaId, itemNumber });
    } else {
      const result = await getInventory({ dataAreaId, itemNumber, top, skip });
      items = result.items;
    }

    return NextResponse.json({
      success: true,
      source: "D365",
      count: items.length,
      items,
    });
  } catch (error) {
    console.error("[D365 Inventory List] Error:", error);
    return NextResponse.json(
      {
        error: "Failed to fetch D365 inventory",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
