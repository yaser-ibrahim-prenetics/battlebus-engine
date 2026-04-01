/**
 * Refund flow wrapper: same Supabase + Dynamics resolution as fulfillment (see d365-order-header-resolution).
 */
import type { D365SalesOrderHeader } from "@/lib/types/dynamics";
import { resolveD365OrderHeaderForLifecycle } from "./d365-order-header-resolution";

export type ShopifyOrderForD365Lookup = {
  name?: string | null;
  shipping_address?: { country_code?: string | null } | null;
};

export async function resolveD365OrderHeaderForRefund(params: {
  shopifyOrderId: string;
  shopifyOrder: ShopifyOrderForD365Lookup;
}): Promise<D365SalesOrderHeader | null> {
  return resolveD365OrderHeaderForLifecycle({
    shopifyOrderId: params.shopifyOrderId,
    shopifyOrderName: params.shopifyOrder.name,
    shippingCountryCode: params.shopifyOrder.shipping_address?.country_code,
  });
}
