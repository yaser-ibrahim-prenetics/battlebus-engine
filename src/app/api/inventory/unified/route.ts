// ============================================================================
// UNIFIED INVENTORY API (READ ONLY)
// ============================================================================
// Fetches inventory from GPS and D365, combines and returns unified view
// This is READ ONLY - no writes to any system
//
// Usage:
//   GET /api/inventory/unified
//   GET /api/inventory/unified?sources=gps,d365
//   GET /api/inventory/unified?sku=IM8-CON-000001
//   GET /api/inventory/unified?dataAreaId=u001

import { NextRequest, NextResponse } from "next/server";
import {
  getInventory as getGpsInventory,
  getAllInventory as getAllGpsInventory,
} from "@/lib/clients/gps";
import {
  getInventory as getD365Inventory,
  getAllInventory as getAllD365Inventory,
} from "@/lib/clients/dynamics";

type Source = "gps" | "d365";

interface UnifiedInventoryItem {
  sku: string;
  productName: string;
  sources: {
    gps?: {
      available: number;
      locked: number;
      transport: number;
      total: number;
      warehouses: Array<{ code: string; name: string; qty: number }>;
    };
    d365?: {
      onHand: number;
      available: number;
      reserved: number;
      ordered: number;
      dataAreas: Array<{ id: string; qty: number }>;
    };
  };
  totalAvailable: number;
  lastFetched: string;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    // Which sources to fetch from
    const sourcesParam = searchParams.get("sources") || "gps,d365";
    const sources = sourcesParam.split(",").map((s) => s.trim().toLowerCase()) as Source[];

    // Filters
    const sku = searchParams.get("sku") || undefined;
    const dataAreaId = searchParams.get("dataAreaId") || undefined;
    const warehouseCode = searchParams.get("warehouseCode") || undefined;

    const unified = new Map<string, UnifiedInventoryItem>();
    const errors: { source: string; error: string }[] = [];

    // Fetch from GPS
    if (sources.includes("gps")) {
      try {
        console.log("[Unified] Fetching GPS inventory...");
        const gpsItems = await getAllGpsInventory({ sku, whCode: warehouseCode });

        for (const item of gpsItems) {
          const existing = unified.get(item.sku) || {
            sku: item.sku,
            productName: item.productName,
            sources: {},
            totalAvailable: 0,
            lastFetched: new Date().toISOString(),
          };

          if (!existing.sources.gps) {
            existing.sources.gps = {
              available: 0,
              locked: 0,
              transport: 0,
              total: 0,
              warehouses: [],
            };
          }

          existing.sources.gps.available += item.productStockDtl.availableAmount;
          existing.sources.gps.locked += item.productStockDtl.lockAmount;
          existing.sources.gps.transport += item.productStockDtl.transportAmount;
          existing.sources.gps.total += item.productTotalAmount;
          existing.sources.gps.warehouses.push({
            code: item.whCode,
            name: item.whName,
            qty: item.productStockDtl.availableAmount,
          });

          existing.totalAvailable =
            existing.sources.gps.available + (existing.sources.d365?.available || 0);
          unified.set(item.sku, existing);
        }

        console.log(`[Unified] GPS: ${gpsItems.length} items`);
      } catch (error) {
        console.error("[Unified] GPS error:", error);
        errors.push({
          source: "gps",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Fetch from D365
    if (sources.includes("d365")) {
      try {
        console.log("[Unified] Fetching D365 inventory...");
        const d365Items = await getAllD365Inventory({ dataAreaId, itemNumber: sku });

        for (const item of d365Items) {
          const itemSku = item.ItemNumber;
          const existing = unified.get(itemSku) || {
            sku: itemSku,
            productName: item.ProductName,
            sources: {},
            totalAvailable: 0,
            lastFetched: new Date().toISOString(),
          };

          if (!existing.sources.d365) {
            existing.sources.d365 = {
              onHand: 0,
              available: 0,
              reserved: 0,
              ordered: 0,
              dataAreas: [],
            };
          }

          existing.sources.d365.onHand += item.OnHandQuantity;
          existing.sources.d365.available += item.AvailableOnHandQuantity;
          existing.sources.d365.reserved += item.ReservedOnHandQuantity;
          existing.sources.d365.ordered += item.OrderedQuantity;
          existing.sources.d365.dataAreas.push({
            id: item.dataAreaId,
            qty: item.AvailableOnHandQuantity,
          });

          // Use GPS available if present, otherwise D365
          if (existing.sources.gps) {
            existing.totalAvailable = existing.sources.gps.available;
          } else {
            existing.totalAvailable = existing.sources.d365.available;
          }

          unified.set(itemSku, existing);
        }

        console.log(`[Unified] D365: ${d365Items.length} items`);
      } catch (error) {
        console.error("[Unified] D365 error:", error);
        errors.push({
          source: "d365",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const items = Array.from(unified.values()).sort((a, b) => a.sku.localeCompare(b.sku));

    return NextResponse.json({
      success: errors.length === 0,
      sources: sources,
      summary: {
        totalSkus: items.length,
        totalAvailable: items.reduce((sum, i) => sum + i.totalAvailable, 0),
        gpsSkus: items.filter((i) => i.sources.gps).length,
        d365Skus: items.filter((i) => i.sources.d365).length,
        bothSystems: items.filter((i) => i.sources.gps && i.sources.d365).length,
      },
      items,
      ...(errors.length > 0 && { errors }),
    });
  } catch (error) {
    console.error("[Unified Inventory] Error:", error);
    return NextResponse.json(
      {
        error: "Failed to fetch unified inventory",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
