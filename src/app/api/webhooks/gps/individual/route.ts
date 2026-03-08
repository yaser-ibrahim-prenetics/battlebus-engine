import { NextRequest, NextResponse } from "next/server";
import { inngest } from "@/inngest/client";

import { errorResponse, successResponse } from "@/lib/utils/response";
import { isValidGpsWarehouse } from "@/lib/helpers/warehouse";
import { GpsWarehouseNameEnum, IGpsManualProcessRequest } from "@/lib/types/gps";
import { IResponse } from "@/lib/types";
import * as gps from "@/lib/clients/gps";

/**
 * POST - Process GPS orders by batch and process it individually
 */
export async function POST(request: NextRequest): Promise<NextResponse<IResponse<any>>> {
  try {
    const body = await request.text();
    const signature = request.headers.get("x-signature");
    const timestamp = request.headers.get("x-timestamp");

    // Parse payload
    const payload: IGpsManualProcessRequest = JSON.parse(body);
    const { gpsOrderIds, warehouse } = payload;

    // Verify webhook signature
    if (signature && timestamp && !gps.verifyWebhookSignature(body, signature, timestamp)) {
      return errorResponse("Invalid signature", 401);
    }

    // Validate gps order IDs
    if (!gpsOrderIds || !Array.isArray(gpsOrderIds) || gpsOrderIds.length === 0) {
      return errorResponse("GPS order id is required and must be a non-empty array", 400);
    }

    // Filter out invalid order IDs
    const validOrderIds = gpsOrderIds.filter(
      (id) => id && typeof id === "string" && id.trim().length > 0
    );
    if (validOrderIds.length === 0) {
      return errorResponse("No valid GPS order IDs provided", 400);
    }

    // Validate warehouse
    if (!warehouse || !isValidGpsWarehouse(warehouse)) {
      return errorResponse(`Invalid warehouse: ${warehouse}`, 400);
    }

    // Process orders in batches
    console.log(`[GPS Individual] Starting processing with ${validOrderIds.length} GPS order IDs`);
    const batchId = `GPSB${Date.now()}`;
    await inngest.send({
      id: batchId,
      name: "gps/batch.process",
      data: {
        gpsOrderIds: validOrderIds,
        warehouse: warehouse as GpsWarehouseNameEnum,
        batchId,
        receivedAt: new Date().toISOString(),
      },
    });

    console.log("[GPS Individual] Processing GPS orders by batch");
    return successResponse("Procesing GPS orders batch", {
      warehouse,
      totalValidOrder: validOrderIds.length,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return errorResponse(`Error processing request: ${errorMessage}`, 500);
  }
}
