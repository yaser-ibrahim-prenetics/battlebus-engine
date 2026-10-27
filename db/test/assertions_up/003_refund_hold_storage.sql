BEGIN;
SET LOCAL ROLE battle_bus_runtime;
INSERT INTO public.refund_hold_decisions
  (shop_domain, source, refund_id, order_id, unfulfilled_line_count, raised_at, timestamp_source, hold_until)
VALUES ('migration-fixture', 'shopify_webhook', '1', '2', 1, now(), 'first_seen', now() + interval '24 hours');
SELECT hold_until FROM public.refund_hold_decisions WHERE shop_domain = 'migration-fixture';
DO $$
BEGIN
  BEGIN
    INSERT INTO public.refund_hold_decisions
      (shop_domain, source, refund_id, order_id, unfulfilled_line_count, raised_at, timestamp_source, hold_until)
    VALUES ('migration-fixture', 'shopify_webhook', '3', '2', 1, now(), 'first_seen', now());
    RAISE EXCEPTION 'Shortened hold was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
ROLLBACK;
