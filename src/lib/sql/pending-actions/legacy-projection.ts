/**
 * Shared identity policy for a legacy JSON action and its normalized row.
 * Internal callers provide fixed SQL expressions, never request data.
 */
export function legacyProjectionIdentitySQL(
  legacyAction: string,
  actionType: string,
  sourceEventId: string
): string {
  return `(
    ${legacyAction}->>'action' = ${actionType}
    AND (
      ${legacyAction}->>'sourceEventId' = ${sourceEventId}
      OR (
        NULLIF(btrim(${legacyAction}->>'sourceEventId'), '') IS NULL
        AND 'legacy:' || md5(${legacyAction}::text) = ${sourceEventId}
      )
    )
  )`;
}

/** Match the same order key priority used by legacy import. */
export function legacyOrderIdentitySQL(orderAlias: string, normalizedOrderId: string): string {
  return `(
    ${orderAlias}.shopify_order_id = ${normalizedOrderId}
    OR ${orderAlias}.platform_order_id = ${normalizedOrderId}
    OR ${orderAlias}.id::text = ${normalizedOrderId}
  )`;
}
