export const orderLookupQueries = {
  d365HintByName: `SELECT d365_order_number, warehouse
       FROM public.orders
       WHERE d365_order_number IS NOT NULL
         AND (shopify_order_name = ANY($1::text[]) OR order_number = ANY($1::text[]) OR id = ANY($1::text[]))
       LIMIT 1`,

  d365HintById: `SELECT d365_order_number, warehouse
     FROM public.orders
     WHERE d365_order_number IS NOT NULL
       AND (shopify_order_id = $1 OR platform_order_id = $1)
     LIMIT 1`,

  stateByName: `SELECT state
       FROM public.orders
       WHERE state IS NOT NULL
         AND (shopify_order_name = ANY($1::text[]) OR order_number = ANY($1::text[]) OR id = ANY($1::text[]))
       LIMIT 1`,

  stateById: `SELECT state
     FROM public.orders
     WHERE state IS NOT NULL AND (shopify_order_id = $1 OR platform_order_id = $1)
     LIMIT 1`,

  gpsRecoveryContextByName: `SELECT shopify_order_name, shopify_order_id, warehouse, gps_order_no,
            gps_uk_order_no, shopify_fulfillment_status, d365_order_number
     FROM public.orders
     WHERE shopify_order_name = ANY($1::text[])
        OR order_number = ANY($1::text[])
        OR id = ANY($1::text[])
     LIMIT 1`,
} as const;
