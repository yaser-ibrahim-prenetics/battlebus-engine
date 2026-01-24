// ============================================================================
// FUNCTION CONSTANTS
// ============================================================================
// Shared constants for Inngest functions

// ============================================================================
// THROTTLE CONFIGURATIONS
// ============================================================================

export const THROTTLE_CONFIGS = {
  DYNAMICS: {
    limit: 10,
    period: "1s" as const,
  },
  SHOPIFY: {
    limit: 2,
    period: "1s" as const,
  },
  GPS: {
    limit: 5,
    period: "1s" as const,
  },
  REFUND: {
    limit: 5,
    period: "1s" as const,
  },
  CANCELLATION: {
    limit: 5,
    period: "1s" as const,
  },
  FULFILLMENT: {
    limit: 5,
    period: "1s" as const,
  },
  CRON: {
    limit: 1,
    period: "60s" as const,
  },
} as const;

// ============================================================================
// CONCURRENCY CONFIGURATIONS
// ============================================================================

export const CONCURRENCY_CONFIGS = {
  ORDER_PROCESSING: {
    limit: 3,
  },
  FULFILLMENT: {
    limit: 1,
  },
  REFUND: {
    limit: 1,
  },
  CANCELLATION: {
    limit: 1,
  },
  STANDARD: {
    limit: 2,
  },
  CRON: {
    limit: 1,
  },
} as const;

// ============================================================================
// RATE LIMIT CONFIGURATIONS
// ============================================================================

export const RATE_LIMIT_CONFIGS = {
  FULFILLMENT: {
    limit: 5,
    period: "24h" as const,
  },
  REFUND: {
    limit: 3,
    period: "24h" as const,
  },
  CANCELLATION: {
    limit: 1,
    period: "1h" as const,
  },
} as const;

// ============================================================================
// RETRY CONFIGURATIONS
// ============================================================================

export const RETRY_CONFIGS = {
  DEFAULT: 5,
  CRITICAL: 10,
  LOW_PRIORITY: 3,
  STANDARD: 5,
  CRON: 3,
} as const;

