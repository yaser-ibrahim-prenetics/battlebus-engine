INSERT INTO public.users (email, auth_id, role_id, status)
SELECT
  'migration-test@example.com',
  '00000000-0000-0000-0000-000000000001',
  r.id,
  'active'
FROM public.roles AS r
WHERE r.name = 'operations';

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000001","email":"migration-test@example.com"}',
  true
);

SET LOCAL ROLE authenticated;

DO $$
BEGIN
  IF public.battle_platform_current_user_id() IS NULL THEN
    RAISE EXCEPTION 'Authenticated user lookup failed';
  END IF;

  IF NOT public.battle_platform_has_permission('read', 'orders') THEN
    RAISE EXCEPTION 'Operations user should be able to read orders';
  END IF;

  IF public.battle_platform_has_permission('manage', 'users') THEN
    RAISE EXCEPTION 'Operations user must not manage users';
  END IF;

  BEGIN
    UPDATE public.users
    SET role_id = (SELECT id FROM public.roles WHERE name = 'superadmin')
    WHERE id = public.battle_platform_current_user_id();
    RAISE EXCEPTION 'Self-service role escalation unexpectedly succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;
END
$$;

SELECT count(*) FROM public.orders;
SELECT count(*) FROM public.inventory;
