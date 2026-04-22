// ============================================================================
// INVENTORY SYNC MESH API
// ============================================================================
// Acts as a central mesh/router for inventory synchronization between platforms
// Supports: Shopify, Dynamics 365, GPS Warehouse, and other warehouse systems
//
// Usage:
//   POST /api/inventory/sync?from=shopify&to=dynamics,warehouse
//   POST /api/inventory/sync?from=warehouse&to=shopify,dynamics
//   POST /api/inventory/sync?from=dynamics&to=shopify,warehouse
//
// The API accepts inventory data and routes it to the specified destinations
// based on the 'from' and 'to' query parameters or request body

import { NextRequest, NextResponse } from "next/server";
import { inngest } from "@/inngest/client";
import { config } from "@/lib/config";

type Platform = "shopify" | "dynamics" | "gps" | "warehouse" | "stord";

interface InventorySyncPayload {
  // Product/Variant identification
  sku?: string;
  inventoryItemId?: string;
  variantId?: string;
  productId?: string;

  // Inventory data
  quantity?: number;
  available?: number;
  reserved?: number;
  committed?: number;

  // Location/Warehouse
  locationId?: string | number;
  warehouseId?: string;
  warehouseName?: string;
  dataAreaId?: string; // For Dynamics

  // Product metadata (for product sync)
  productTitle?: string;
  variantTitle?: string;
  barcode?: string;
  price?: string | number;
  weight?: number;
  weightUnit?: string;

  // Action type
  action?: "create" | "update" | "delete" | "adjust";

  // Metadata
  source?: Platform;
  destination?: Platform | Platform[];
  timestamp?: string;
  reason?: string;
}

export async function POST(request: NextRequest) {
  try {
    if (!config.features.enableInventorySync) {
      return NextResponse.json(
        {
          error: "Inventory sync is disabled",
          hint: "Set ENABLE_INVENTORY_SYNC=true to allow mesh sync writes.",
        },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(request.url);
    const fromPlatform = searchParams.get("from") as Platform | null;
    const toPlatforms = searchParams
      .get("to")
      ?.split(",")
      .map((p) => p.trim()) as Platform[] | null;

    const body: InventorySyncPayload = await request.json();

    // Determine source platform: from query param, body, or infer from payload
    const source: Platform = fromPlatform || body.source || "shopify";

    // Determine destination platforms: from query param, body, or default to all
    let destinations: Platform[] = [];
    if (toPlatforms && toPlatforms.length > 0) {
      destinations = toPlatforms;
    } else if (body.destination) {
      destinations = Array.isArray(body.destination) ? body.destination : [body.destination];
    } else {
      // Default: sync to all platforms except source
      destinations = ["shopify", "dynamics", "gps"].filter((p) => p !== source) as Platform[];
    }

    // Validate required fields
    if (!body.sku && !body.inventoryItemId && !body.variantId) {
      return NextResponse.json(
        { error: "sku, inventoryItemId, or variantId is required" },
        { status: 400 }
      );
    }

    if (body.action === "delete" && !body.productId && !body.variantId) {
      return NextResponse.json(
        { error: "productId or variantId is required for delete action" },
        { status: 400 }
      );
    }

    // Generate unique event ID for idempotency
    const eventId = `inventory-sync-${source}-${body.sku || body.inventoryItemId || body.variantId}-${body.locationId || "default"}-${Date.now()}`;

    // Send Inngest event for each destination
    // Use Promise.allSettled to ensure all promises complete even if some fail
    const eventPromises = destinations.map(async (destination) => {
      try {
        const result = await inngest.send({
          id: `${eventId}-${destination}`,
          name: "inventory/sync",
          data: {
            source,
            destination,
            payload: {
              ...body,
              source,
              destination,
              timestamp: body.timestamp || new Date().toISOString(),
            },
          },
        });
        return { success: true, destination, result };
      } catch (error) {
        // Log error but don't fail the entire request
        console.error(`[Inventory Sync Mesh] Failed to send event to ${destination}:`, error);
        // In local dev, Inngest might not be running - that's okay for testing
        if (process.env.NODE_ENV === "development") {
          console.warn(
            `[Inventory Sync Mesh] Inngest not available - event queued but not sent. Start Inngest dev server: npm run dev:inngest`
          );
        }
        return {
          success: false,
          destination,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    const results = await Promise.allSettled(eventPromises);
    const errors: Array<{ destination: string; error: string }> = [];
    const successes: Array<{ destination: string }> = [];

    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        if (result.value.success) {
          successes.push({ destination: result.value.destination });
        } else {
          errors.push({
            destination: result.value.destination,
            error: result.value.error || "Unknown error",
          });
        }
      } else {
        // Promise itself was rejected (shouldn't happen with our try-catch, but handle it)
        errors.push({
          destination: destinations[index],
          error: result.reason?.message || String(result.reason),
        });
      }
    });

    const allSuccessful = errors.length === 0;

    // In production, log warnings but don't fail (events might be queued)
    if (errors.length > 0) {
      console.warn(`[Inventory Sync Mesh] ${errors.length} event(s) failed to send:`, errors);
    }
    const responseMessage = allSuccessful
      ? `Inventory sync initiated from ${source} to ${destinations.join(", ")}`
      : `Inventory sync queued from ${source} to ${destinations.join(", ")} (${errors.length} event(s) failed - check Inngest dev server)`;

    return NextResponse.json(
      {
        success: allSuccessful,
        message: responseMessage,
        source,
        destinations,
        eventId,
        ...(errors.length > 0 && {
          warnings: errors.map((e: any) => ({
            destination: e.destination,
            error: e.error,
          })),
          note:
            process.env.NODE_ENV === "development"
              ? "In development mode, events are queued but may not be processed until Inngest dev server is running. Run: npm run dev:inngest"
              : undefined,
        }),
      },
      { status: allSuccessful ? 200 : 202 } // 202 Accepted if some events failed
    );
  } catch (error) {
    console.error("[Inventory Sync Mesh] Error:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

// GET endpoint for health check and documentation
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  if (searchParams.get("docs") === "true") {
    return NextResponse.json({
      name: "Inventory Sync Mesh API",
      description: "Central mesh/router for inventory synchronization between platforms",
      supportedPlatforms: ["shopify", "dynamics", "gps", "warehouse", "stord"],
      usage: {
        method: "POST",
        url: "/api/inventory/sync",
        queryParams: {
          from: "Source platform (shopify, dynamics, gps, etc.)",
          to: "Comma-separated destination platforms",
        },
        body: {
          sku: "Product SKU",
          inventoryItemId: "Shopify inventory item ID",
          variantId: "Product variant ID",
          quantity: "Inventory quantity",
          available: "Available quantity",
          locationId: "Location/warehouse ID",
          action: "create | update | delete | adjust",
          source: "Source platform (optional, can use query param)",
          destination: "Destination platform(s) (optional, can use query param)",
        },
      },
      examples: [
        {
          description: "Sync inventory from Shopify to Dynamics and GPS",
          url: "/api/inventory/sync?from=shopify&to=dynamics,gps",
          body: {
            sku: "PROD-123",
            quantity: 100,
            locationId: "79527313640",
            action: "update",
          },
        },
        {
          description: "Sync inventory from warehouse to Shopify",
          url: "/api/inventory/sync?from=warehouse&to=shopify",
          body: {
            sku: "PROD-123",
            available: 50,
            warehouseId: "GPS-US",
            action: "update",
          },
        },
      ],
    });
  }

  return NextResponse.json({
    status: "ok",
    service: "inventory-sync-mesh",
    version: "1.0.0",
  });
}
