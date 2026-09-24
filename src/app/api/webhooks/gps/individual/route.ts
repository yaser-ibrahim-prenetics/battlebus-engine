import { NextRequest, NextResponse } from "next/server";

import { errorResponse, successResponse } from "@/lib/utils/response";
import { isValidGpsWarehouse } from "@/lib/helpers/warehouse";
import { GpsWarehouseNameEnum, IGpsManualProcessRequest } from "@/lib/types/gps";
import { IResponse } from "@/lib/types";
import * as gps from "@/lib/clients/gps";
import { publishWebhookEvents } from "@/lib/webhooks/publish-with-inbox";

/**
 * POST - Process GPS orders by batch and process it individually
 */
export async function POST(request: NextRequest): Promise<NextResponse<IResponse<any>>> {
  try {
    const body = await request.text();
    const signature = request.headers.get("x-signature");
    const timestamp = request.headers.get("x-timestamp");

    // Fail closed: this route queues warehouse work and must never accept an
    // unsigned request when Cloud Run is reachable from external systems.
    if (!signature || !timestamp) {
      return errorResponse("Missing signature headers", 401);
    }
    if (!gps.verifyWebhookSignature(body, signature, timestamp)) {
      return errorResponse("Invalid signature", 401);
    }

    // Parse only after authenticating the raw bytes used for the HMAC.
    const payload: IGpsManualProcessRequest = JSON.parse(body);
    const { gpsOrderIds, warehouse } = payload;

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
    const result = await publishWebhookEvents({
      source: "gps_individual",
      topic: "gps/batch.process",
      payload,
      headers: Object.fromEntries(request.headers.entries()),
      events: [
        {
          id: batchId,
          name: "gps/batch.process",
          data: {
            gpsOrderIds: validOrderIds,
            warehouse: warehouse as GpsWarehouseNameEnum,
            batchId,
            receivedAt: new Date().toISOString(),
          },
        },
      ],
    });

    if (!result.published) {
      return errorResponse("Failed to publish gps/batch.process event to Inngest", 502);
    }

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
