export const readPlanSQL = `SELECT plan, progress FROM public.order_segment_plans
  WHERE shop_domain=$1 AND shopify_order_id=$2`;
export const reservePlanSQL = `INSERT INTO public.order_segment_plans (shop_domain, shopify_order_id, plan)
  VALUES ($1,$2,$3::jsonb) ON CONFLICT DO NOTHING`;
export const updateProgressSQL = `UPDATE public.order_segment_plans
  SET progress=jsonb_set(progress, ARRAY[$3::text], COALESCE(progress->$3::text, '{}'::jsonb) || $4::jsonb),
      updated_at=now()
  WHERE shop_domain=$1 AND shopify_order_id=$2 RETURNING shopify_order_id`;
export const findGpsSegmentSQL = `SELECT shopify_order_id, plan, progress FROM public.order_segment_plans
  WHERE shop_domain=$1 AND EXISTS (
    SELECT 1 FROM jsonb_each(progress) entry WHERE entry.value->>'gpsOrderId'=$2
  ) LIMIT 2`;
export const pollGpsSegmentsSQL = `SELECT p.shopify_order_id AS "shopifyOrderId", p.plan->>'orderName' AS "shopifyOrderName",
  segment->>'warehouse' AS warehouse, p.progress->(segment->>'index')->>'gpsOrderId' AS "gpsOrderId"
  FROM public.order_segment_plans p CROSS JOIN LATERAL jsonb_array_elements(p.plan->'segments') segment
  WHERE p.shop_domain=$1 AND p.created_at >= $2
    AND p.progress->(segment->>'index')->>'gpsOrderId' IS NOT NULL
    AND COALESCE(p.progress->(segment->>'index')->>'fulfilled','false') <> 'true'
  ORDER BY p.created_at LIMIT 500`;
