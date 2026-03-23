// ============================================================================
// PENDING ACTIONS SERVICE
// ============================================================================
// Stores and retrieves deferred lifecycle actions (fulfill, cancel, refund)
// for orders whose D365/GPS creation has not yet completed.
// Uses Battle Hub API to persist in the Supabase orders.pending_actions column.

import { config } from "@/lib/config";
import crypto from "crypto";

export type PendingActionType = "fulfill" | "cancel" | "refund";

export interface PendingAction {
  action: PendingActionType;
  eventName: string;
  eventData: Record<string, unknown>;
  createdAt: string;
}

function generateSignature(payload: string): string {
  if (!config.csPlatform.webhookSecret) return "";
  return crypto.createHmac("sha256", config.csPlatform.webhookSecret).update(payload).digest("hex");
}

async function callHubApi(
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  if (!config.csPlatform.baseUrl) {
    throw new Error("[PendingActions] CS_PLATFORM_URL not configured");
  }

  const url = `${config.csPlatform.baseUrl}${path}`;
  const payload = body ? JSON.stringify(body) : undefined;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-battle-bus-signature": payload ? generateSignature(payload) : "",
  };

  const serviceSecret =
    process.env.INTERNAL_SERVICE_SECRET || config.csPlatform.webhookSecret;
  if (serviceSecret) {
    headers["Authorization"] = `Bearer ${serviceSecret}`;
  }

  const response = await fetch(url, { method, headers, body: payload });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `[PendingActions] Hub API ${method} ${path} failed ${response.status}: ${text}`
    );
  }
  return response.json();
}

export async function storePendingAction(
  shopifyOrderId: string,
  action: PendingAction
): Promise<void> {
  console.log(
    `[PendingActions] Storing ${action.action} for shopifyOrderId=${shopifyOrderId}`
  );
  await callHubApi("PATCH", "/api/orders/pending-actions", {
    shopifyOrderId,
    operation: "append",
    action,
  });
}

export async function getPendingActions(
  shopifyOrderId: string
): Promise<PendingAction[]> {
  const result = (await callHubApi(
    "GET",
    `/api/orders/pending-actions?shopifyOrderId=${encodeURIComponent(shopifyOrderId)}`,
  )) as { actions: PendingAction[] };
  return result.actions || [];
}

export interface PendingActionOrder {
  shopify_order_id: string;
  shopify_order_name: string;
  pending_actions: PendingAction[];
}

export async function getAllPendingActionOrders(): Promise<PendingActionOrder[]> {
  const result = (await callHubApi(
    "GET",
    "/api/orders/pending-actions",
  )) as { orders: PendingActionOrder[]; count: number };
  return result.orders || [];
}

export async function clearPendingActions(
  shopifyOrderId: string
): Promise<void> {
  console.log(
    `[PendingActions] Clearing pending actions for shopifyOrderId=${shopifyOrderId}`
  );
  await callHubApi("PATCH", "/api/orders/pending-actions", {
    shopifyOrderId,
    operation: "clear",
  });
}

export async function clearPendingActionsBatch(
  shopifyOrderIds: string[]
): Promise<void> {
  if (shopifyOrderIds.length === 0) return;
  console.log(
    `[PendingActions] Bulk-clearing pending actions for ${shopifyOrderIds.length} orders`
  );
  await callHubApi("PATCH", "/api/orders/pending-actions", {
    shopifyOrderIds,
    operation: "clear-batch",
  });
}
