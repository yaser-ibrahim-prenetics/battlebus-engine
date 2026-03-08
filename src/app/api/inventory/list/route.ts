// ============================================================================
// INVENTORY LIST API
// ============================================================================
// Fetches inventory from GPS warehouse system
//
// Usage:
//   GET /api/inventory/list
//   GET /api/inventory/list?sku=IM8-CON-000027
//   GET /api/inventory/list?warehouse=GPS%20Warehouse
//   GET /api/inventory/list?page=1&pageSize=50
//
// Query Parameters:
//   - sku: Filter by specific SKU
//   - warehouse: "GPS Warehouse" or "GPS UK Warehouse"
//   - whCode: Filter by warehouse code (e.g., "JFK01W", "GB03RS")
//   - page: Page number (default: 1)
//   - pageSize: Items per page (default: 100)
//   - all: Set to "true" to fetch all pages (WARNING: may be slow)

import { NextRequest, NextResponse } from "next/server";
import { getInventory, getAllInventory, type GpsInventoryItem } from "@/lib/clients/gps";

type GpsWarehouseName = "GPS Warehouse" | "GPS UK Warehouse";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    const sku = searchParams.get("sku") || undefined;
    const warehouseName = (searchParams.get("warehouse") || "GPS Warehouse") as GpsWarehouseName;
    const whCode = searchParams.get("whCode") || undefined;
    const page = parseInt(searchParams.get("page") || "1", 10);
    const pageSize = parseInt(searchParams.get("pageSize") || "100", 10);
    const fetchAll = searchParams.get("all") === "true";

    // Validate warehouse name
    if (warehouseName !== "GPS Warehouse" && warehouseName !== "GPS UK Warehouse") {
      return NextResponse.json(
        { error: "Invalid warehouse. Use 'GPS Warehouse' or 'GPS UK Warehouse'" },
        { status: 400 }
      );
    }

    // Validate pagination
    if (page < 1 || pageSize < 1 || pageSize > 500) {
      return NextResponse.json(
        { error: "Invalid pagination. page >= 1, pageSize: 1-500" },
        { status: 400 }
      );
    }

    let items: GpsInventoryItem[];
    let pagination: { page: number; pageSize: number; pages: number; total: number } | null = null;

    if (fetchAll) {
      // Fetch all pages
      items = await getAllInventory({ sku, whCode, pageSize }, warehouseName);
      pagination = {
        page: 1,
        pageSize: items.length,
        pages: 1,
        total: items.length,
      };
    } else {
      // Fetch single page
      const { response } = await getInventory(
        { pageNum: page, pageSize, sku, whCode },
        warehouseName
      );
      items = response.data.records;
      pagination = {
        page: response.data.page,
        pageSize: response.data.pageSize,
        pages: response.data.pages,
        total: response.data.total,
      };
    }

    // Aggregate inventory by SKU (sum across warehouses)
    const aggregated = new Map<
      string,
      {
        sku: string;
        productName: string;
        totalAvailable: number;
        totalLocked: number;
        totalTransport: number;
        warehouses: Array<{
          whCode: string;
          whName: string;
          available: number;
          locked: number;
          transport: number;
          total: number;
        }>;
      }
    >();

    for (const item of items) {
      const existing = aggregated.get(item.sku);
      const warehouseEntry = {
        whCode: item.whCode,
        whName: item.whName,
        available: item.productStockDtl.availableAmount,
        locked: item.productStockDtl.lockAmount,
        transport: item.productStockDtl.transportAmount,
        total: item.productTotalAmount,
      };

      if (existing) {
        existing.totalAvailable += item.productStockDtl.availableAmount;
        existing.totalLocked += item.productStockDtl.lockAmount;
        existing.totalTransport += item.productStockDtl.transportAmount;
        existing.warehouses.push(warehouseEntry);
      } else {
        aggregated.set(item.sku, {
          sku: item.sku,
          productName: item.productName,
          totalAvailable: item.productStockDtl.availableAmount,
          totalLocked: item.productStockDtl.lockAmount,
          totalTransport: item.productStockDtl.transportAmount,
          warehouses: [warehouseEntry],
        });
      }
    }

    return NextResponse.json({
      success: true,
      warehouse: warehouseName,
      pagination,
      items: Array.from(aggregated.values()),
      raw: items, // Include raw response for debugging
    });
  } catch (error) {
    console.error("[Inventory List] Error:", error);
    return NextResponse.json(
      {
        error: "Failed to fetch inventory",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

// POST endpoint with same functionality (for clients that prefer POST)
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const sku = body.sku || undefined;
    const warehouseName = (body.warehouse || "GPS Warehouse") as GpsWarehouseName;
    const whCode = body.whCode || undefined;
    const page = body.page || 1;
    const pageSize = body.pageSize || 100;
    const fetchAll = body.all === true;

    // Validate warehouse name
    if (warehouseName !== "GPS Warehouse" && warehouseName !== "GPS UK Warehouse") {
      return NextResponse.json(
        { error: "Invalid warehouse. Use 'GPS Warehouse' or 'GPS UK Warehouse'" },
        { status: 400 }
      );
    }

    let items: GpsInventoryItem[];
    let pagination: { page: number; pageSize: number; pages: number; total: number } | null = null;

    if (fetchAll) {
      items = await getAllInventory({ sku, whCode, pageSize }, warehouseName);
      pagination = {
        page: 1,
        pageSize: items.length,
        pages: 1,
        total: items.length,
      };
    } else {
      const { response } = await getInventory(
        { pageNum: page, pageSize, sku, whCode },
        warehouseName
      );
      items = response.data.records;
      pagination = {
        page: response.data.page,
        pageSize: response.data.pageSize,
        pages: response.data.pages,
        total: response.data.total,
      };
    }

    return NextResponse.json({
      success: true,
      warehouse: warehouseName,
      pagination,
      items,
    });
  } catch (error) {
    console.error("[Inventory List] Error:", error);
    return NextResponse.json(
      {
        error: "Failed to fetch inventory",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
