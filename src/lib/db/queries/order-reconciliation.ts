export const orderReconciliationQueries = {
  findByNames: `SELECT shopify_order_name, d365_order_number, d365_sync_status, gps_order_no,
                gps_uk_order_no, gps_sync_status, shopify_financial_status,
                shopify_cancelled_at, shopify_fulfillment_status, warehouse
         FROM public.orders
         WHERE shopify_order_name = ANY($1::text[])`,
} as const;
