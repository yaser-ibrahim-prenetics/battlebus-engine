import { config } from "@/lib/config";
import type { ReconType } from "./types";

export function toStoreCode(): string {
  const fromEnv = process.env.RECONCILIATION_STORE_CODE?.trim();
  if (fromEnv) return fromEnv;
  const domain = config.shopify.im8.shopDomain || "";
  if (!domain) return "im8";
  return domain.split(".")[0] || "im8";
}

export function typeLabel(t: ReconType): string {
  if (t === "salesorder") return "SalesOrder Reconciliation";
  if (t === "gps_us") return "GPS SalesOrder Reconciliation";
  if (t === "fulfillment") return "Fulfillment Reconciliation";
  return "GPS UK SalesOrder Reconciliation";
}

export function extractShopifyOrderId(orderId: string): string | null {
  const raw = String(orderId || "").trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return raw;
  const match = raw.match(/\/(\d+)\s*$/);
  return match ? match[1] : null;
}

