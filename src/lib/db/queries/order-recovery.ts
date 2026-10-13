export const orderRecoveryQueries = {
  existingIds: `SELECT shopify_order_id FROM public.orders WHERE shopify_order_id = ANY($1::text[])`,
  existingNames: `SELECT shopify_order_name FROM public.orders WHERE shopify_order_name = ANY($1::text[])`,
} as const;
