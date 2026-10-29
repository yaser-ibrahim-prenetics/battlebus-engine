export const acquireBackorderRecoveryLeaseSQL = `
  INSERT INTO public.backorder_recovery_leases (
    shopify_store,
    order_id,
    lease_token,
    lease_expires_at,
    last_operation_key,
    last_lease_owner,
    acquired_at,
    released_at,
    updated_at
  ) VALUES ($1, $2, $3, now() + make_interval(secs => $4), $5, $6, now(), NULL, now())
  ON CONFLICT (shopify_store, order_id) DO UPDATE
  SET lease_token = EXCLUDED.lease_token,
      lease_expires_at = EXCLUDED.lease_expires_at,
      last_operation_key = EXCLUDED.last_operation_key,
      last_lease_owner = EXCLUDED.last_lease_owner,
      acquired_at = EXCLUDED.acquired_at,
      released_at = NULL,
      updated_at = now()
  WHERE backorder_recovery_leases.lease_token IS NULL
     OR backorder_recovery_leases.lease_expires_at <= now()
  RETURNING shopify_store, order_id, lease_token, lease_expires_at
`;

export const releaseBackorderRecoveryLeaseSQL = `
  UPDATE public.backorder_recovery_leases
  SET lease_token = NULL,
      lease_expires_at = NULL,
      released_at = now(),
      updated_at = now()
  WHERE shopify_store = $1
    AND order_id = $2
    AND lease_token = $3
  RETURNING shopify_store, order_id
`;
