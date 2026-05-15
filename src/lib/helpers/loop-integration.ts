/**
 * Loop Returns integration flags (environment).
 * Mirrors spock-store `DISABLE_LOOP_WEBHOOK_VERIFICATION` + explicit Battle Bus switches.
 */

/** Hard kill-switch: disables webhook + Shopify duplicate detection that calls order events API. */
export function isLoopRefundWebhookGloballyDisabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.ENABLE_LOOP_RETURN_REFUND_WEBHOOK === "false";
}

/**
 * Whether Loop Returns refund integration is enabled.
 *
 * Priority:
 * 1. `ENABLE_LOOP_RETURN_REFUND_WEBHOOK=false` → disabled (legacy kill-switch).
 * 2. `ENABLE_LOOP_RETURNS=true`/`1` → enabled (register `POST /api/webhooks/loop` in Loop dashboard).
 * 3. Unset or other values → disabled (explicit opt-in avoids accepting webhooks unintentionally).
 */
export function resolveLoopReturnsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isLoopRefundWebhookGloballyDisabled(env)) return false;
  const raw =
    typeof env.ENABLE_LOOP_RETURNS === "string" ? env.ENABLE_LOOP_RETURNS.trim().toLowerCase() : "";
  if (raw === "false" || raw === "0") return false;
  return raw === "true" || raw === "1";
}

export function loopWebhookSigningConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.LOOP_WEBHOOK_KEY?.trim());
}

export function resolveLoopWebhookVerifyDisabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.DISABLE_LOOP_WEBHOOK_VERIFICATION === "true";
}
