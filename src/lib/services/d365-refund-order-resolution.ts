/**
 * Refund flow wrapper: same Supabase + Dynamics resolution as fulfillment (see d365-order-header-resolution).
 */
import type { D365SalesOrderHeader } from "@/lib/types/dynamics";
import type { D365ODataTraceContext } from "@/lib/utils/d365-odata-trace";
import {
  resolveD365OrderHeaderForLifecycle,
  resolveD365OrderHeaderForLifecycleWithAudit,
  type ResolveD365OrderHeaderResult,
} from "./d365-order-header-resolution";

export type ShopifyOrderForD365Lookup = {
  name?: string | null;
  shipping_address?: { country_code?: string | null } | null;
};

type RefundResolveParams = {
  shopifyOrderId: string;
  shopifyOrder: ShopifyOrderForD365Lookup;
  trace?: D365ODataTraceContext;
};

function lifecycleInput(params: RefundResolveParams) {
  return {
    shopifyOrderId: params.shopifyOrderId,
    shopifyOrderName: params.shopifyOrder.name,
    shippingCountryCode: params.shopifyOrder.shipping_address?.country_code,
    trace: params.trace,
  };
}

export async function resolveD365OrderHeaderForRefund(
  params: RefundResolveParams
): Promise<D365SalesOrderHeader | null> {
  return resolveD365OrderHeaderForLifecycle(lifecycleInput(params));
}

/** Refund + Inngest: returns header and `audit` for non-null step output. */
export async function resolveD365OrderHeaderForRefundWithAudit(
  params: RefundResolveParams
): Promise<ResolveD365OrderHeaderResult> {
  return resolveD365OrderHeaderForLifecycleWithAudit(lifecycleInput(params));
}
