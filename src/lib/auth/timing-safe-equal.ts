// ============================================================================
// TIMING-SAFE STRING COMPARISON
// ============================================================================
// Shared helper so secret/credential comparisons across the app don't leak
// timing information via short-circuiting string equality checks.

import crypto from "crypto";

export function timingSafeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}
