// ============================================================================
// GPS WAREHOUSE API CLIENT
// ============================================================================
// Extracted from spock-store src/component/gps.ts
// Refactored for stateless execution with Inngest

import crypto from "crypto";
import { config } from "../config";
import type { GpsOutboundOrder, GpsFulfilmentNotification } from "../types/gps";

/**
 * Generate HMAC-SHA256 signature for GPS API authentication
 */
function generateSignature(
  timestamp: string,
  method: string,
  path: string,
  body: string = ""
): string {
  const message = `${timestamp}${method}${path}${body}`;
  return crypto
    .createHmac("sha256", config.gps.apiSecret)
    .update(message)
    .digest("hex");
}

/**
 * Get authentication headers for GPS API
 */
function getAuthHeaders(
  method: string,
  path: string,
  body: string = ""
): Record<string, string> {
  const timestamp = new Date().toISOString();
  const signature = generateSignature(timestamp, method, path, body);

  return {
    "X-API-Key": config.gps.apiKey,
    "X-Signature": signature,
    "X-Timestamp": timestamp,
    "Content-Type": "application/json",
  };
}

/**
 * Create an Outbound Order in GPS Warehouse
 */
export async function createOutboundOrder(
  order: GpsOutboundOrder
): Promise<{ orderId: string; status: string }> {
  const path = "/api/v1/outbound-orders";
  const body = JSON.stringify(order);
  const headers = getAuthHeaders("POST", path, body);

  const response = await fetch(`${config.gps.baseUrl}${path}`, {
    method: "POST",
    headers,
    body,
  });

  if (!response.ok) {
    const error = await response.text();
    
    // Check for specific error types
    if (response.status === 409) {
      // Duplicate order - this is actually OK for idempotency
      console.log(`GPS order already exists: ${order.orderNumber}`);
      return { orderId: order.orderNumber, status: "duplicate" };
    }
    
    if (response.status === 422 && error.includes("out of stock")) {
      throw new OutOfStockError(`GPS out of stock for order ${order.orderNumber}`);
    }

    throw new Error(`Failed to create GPS outbound order: ${response.status} - ${error}`);
  }

  return response.json();
}

/**
 * Get Order Status from GPS
 */
export async function getOrderStatus(
  orderNumber: string
): Promise<GpsFulfilmentNotification | null> {
  const path = `/api/v1/outbound-orders/${orderNumber}`;
  const headers = getAuthHeaders("GET", path);

  const response = await fetch(`${config.gps.baseUrl}${path}`, {
    method: "GET",
    headers,
  });

  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }
    const error = await response.text();
    throw new Error(`Failed to get GPS order status: ${response.status} - ${error}`);
  }

  return response.json();
}

/**
 * Cancel an Outbound Order in GPS
 */
export async function cancelOutboundOrder(
  orderNumber: string
): Promise<void> {
  const path = `/api/v1/outbound-orders/${orderNumber}/cancel`;
  const headers = getAuthHeaders("POST", path);

  const response = await fetch(`${config.gps.baseUrl}${path}`, {
    method: "POST",
    headers,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to cancel GPS order: ${response.status} - ${error}`);
  }
}

/**
 * Verify GPS Webhook Signature
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  timestamp: string
): boolean {
  const expectedSignature = generateSignature(timestamp, "POST", "/webhook", payload);
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

// Custom error for Out of Stock scenarios
export class OutOfStockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutOfStockError";
  }
}
