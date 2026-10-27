export const lockAllocationsSQL = `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`;
export const readAllocationsSQL = `SELECT fulfillment_id, segment_index, request_hash, quantities, include_services, completed
  FROM public.order_segment_fulfillments WHERE shop_domain=$1 AND shopify_order_id=$2`;
export const reserveAllocationSQL = `INSERT INTO public.order_segment_fulfillments
  (shop_domain, shopify_order_id, fulfillment_id, segment_index, request_hash, quantities, include_services)
  VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`;
export const completeAllocationSQL = `UPDATE public.order_segment_fulfillments SET completed=true
  WHERE shop_domain=$1 AND shopify_order_id=$2 AND fulfillment_id=$3 AND segment_index=$4`;
