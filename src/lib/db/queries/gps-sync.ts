export const gpsSyncQueries = {
  recentUnfulfilledOrders: `SELECT id, shopify_order_id, shopify_order_name, gps_order_no, warehouse
         FROM public.orders
         WHERE gps_order_no IS NOT NULL
           AND warehouse = ANY($1::text[])
           AND (shopify_fulfillment_status IS NULL OR shopify_fulfillment_status <> 'fulfilled')
           AND created_at >= $2
         LIMIT 500`,
} as const;
