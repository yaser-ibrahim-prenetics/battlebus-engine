export const lockRefundsSQL = `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`;
export const readRefundsSQL = `SELECT refund_id, request_hash, allocations, completed
  FROM public.order_segment_refunds WHERE shop_domain=$1 AND shopify_order_id=$2`;
export const reserveRefundSQL = `INSERT INTO public.order_segment_refunds
  (shop_domain, shopify_order_id, refund_id, request_hash, allocations) VALUES ($1,$2,$3,$4,$5::jsonb)`;
export const completeRefundSQL = `UPDATE public.order_segment_refunds SET completed=true, completed_at=now()
  WHERE shop_domain=$1 AND shopify_order_id=$2 AND refund_id=$3 RETURNING refund_id`;
