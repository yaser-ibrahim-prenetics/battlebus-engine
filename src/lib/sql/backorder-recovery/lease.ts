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

export const readBackorderRecoveryLeaseSQL = `
  SELECT lease_expires_at
  FROM public.backorder_recovery_leases
  WHERE shopify_store = $1
    AND order_id = $2
`;

export const renewBackorderRecoveryLeaseSQL = `
  UPDATE public.backorder_recovery_leases
  SET lease_token = $3,
      lease_expires_at = now() + make_interval(secs => $4),
      acquired_at = CASE
        WHEN lease_token IS NULL OR lease_expires_at <= now() THEN now()
        ELSE acquired_at
      END,
      released_at = NULL,
      updated_at = now()
  WHERE shopify_store = $1
    AND order_id = $2
    AND (
      lease_token = $3
      OR (
        (lease_token IS NULL OR lease_expires_at <= now())
        AND last_operation_key = $5
        AND last_lease_owner = $6
      )
    )
  RETURNING shopify_store, order_id, lease_token, lease_expires_at
`;

export const releaseBackorderRecoveryLeaseSQL = `
  UPDATE public.backorder_recovery_leases
  SET lease_token = NULL,
      lease_expires_at = NULL,
      released_at = COALESCE(released_at, now()),
      updated_at = CASE WHEN lease_token = $3 THEN now() ELSE updated_at END
  WHERE shopify_store = $1
    AND order_id = $2
    AND (
      lease_token = $3
      OR (
        lease_token IS NULL
        AND last_operation_key = $4
        AND last_lease_owner = $5
      )
    )
  RETURNING shopify_store, order_id
`;
