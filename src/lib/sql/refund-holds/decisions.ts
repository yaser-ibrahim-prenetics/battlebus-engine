// First observation wins. A retry must never move the deadline or reclassify lines.
export const insertDecisionSQL = `
  INSERT INTO public.refund_hold_decisions
    (shop_domain, source, refund_id, order_id, unfulfilled_line_count,
     raised_at, timestamp_source, hold_until)
  VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()), $7,
    CASE WHEN $5::integer > 0 THEN COALESCE($6::timestamptz, now()) + interval '24 hours' END)
  ON CONFLICT (shop_domain, source, refund_id) DO NOTHING
`;

// Separate statement sees a concurrently committed INSERT after ON CONFLICT waits.
export const readDecisionSQL = `
  SELECT order_id, unfulfilled_line_count, hold_until,
    COALESCE(hold_until > clock_timestamp(), false) AS waiting
  FROM public.refund_hold_decisions
  WHERE shop_domain = $1 AND source = $2 AND refund_id = $3
`;
