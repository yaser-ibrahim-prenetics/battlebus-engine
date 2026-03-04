// ============================================================================
// FUNCTION CONSTANTS
// ============================================================================
// Shared constants for Inngest functions
// All values are configurable via environment variables with sensible defaults

// Helper to parse int from env with fallback
const envInt = (key: string, fallback: number): number =>
  parseInt(process.env[key] || String(fallback), 10);

// ============================================================================
// THROTTLE CONFIGURATIONS
// ============================================================================

export const THROTTLE_CONFIGS = {
  // D365 service protection limits allow 6000 requests/5min = 20/sec
  // Default 15/sec leaves headroom
  DYNAMICS: {
    limit: envInt("THROTTLE_DYNAMICS_LIMIT", 15),
    period: (process.env.THROTTLE_DYNAMICS_PERIOD || "1s") as "1s",
  },
  // Shopify REST API allows 40 requests/sec with leaky bucket
  SHOPIFY: {
    limit: envInt("THROTTLE_SHOPIFY_LIMIT", 4),
    period: (process.env.THROTTLE_SHOPIFY_PERIOD || "1s") as "1s",
  },
  GPS: {
    limit: envInt("THROTTLE_GPS_LIMIT", 10),
    period: (process.env.THROTTLE_GPS_PERIOD || "1s") as "1s",
  },
  REFUND: {
    limit: envInt("THROTTLE_REFUND_LIMIT", 5),
    period: (process.env.THROTTLE_REFUND_PERIOD || "1s") as "1s",
  },
  CANCELLATION: {
    limit: envInt("THROTTLE_CANCELLATION_LIMIT", 5),
    period: (process.env.THROTTLE_CANCELLATION_PERIOD || "1s") as "1s",
  },
  FULFILLMENT: {
    limit: envInt("THROTTLE_FULFILLMENT_LIMIT", 5),
    period: (process.env.THROTTLE_FULFILLMENT_PERIOD || "1s") as "1s",
  },
  CRON: {
    limit: envInt("THROTTLE_CRON_LIMIT", 1),
    period: (process.env.THROTTLE_CRON_PERIOD || "60s") as "60s",
  },
};

// ============================================================================
// CONCURRENCY CONFIGURATIONS
// ============================================================================

export const CONCURRENCY_CONFIGS = {
  ORDER_PROCESSING: {
    limit: envInt("CONCURRENCY_ORDER_PROCESSING", 3),
  },
  FULFILLMENT: {
    limit: envInt("CONCURRENCY_FULFILLMENT", 1),
  },
  REFUND: {
    limit: envInt("CONCURRENCY_REFUND", 1),
  },
  CANCELLATION: {
    limit: envInt("CONCURRENCY_CANCELLATION", 1),
  },
  STANDARD: {
    limit: envInt("CONCURRENCY_STANDARD", 2),
  },
  CRON: {
    limit: envInt("CONCURRENCY_CRON", 1),
  },
};

// ============================================================================
// RATE LIMIT CONFIGURATIONS
// ============================================================================

export const RATE_LIMIT_CONFIGS = {
  FULFILLMENT: {
    limit: envInt("RATE_LIMIT_FULFILLMENT", 5),
    period: (process.env.RATE_LIMIT_FULFILLMENT_PERIOD || "24h") as "24h",
  },
  REFUND: {
    limit: envInt("RATE_LIMIT_REFUND", 3),
    period: (process.env.RATE_LIMIT_REFUND_PERIOD || "24h") as "24h",
  },
  CANCELLATION: {
    limit: envInt("RATE_LIMIT_CANCELLATION", 1),
    period: (process.env.RATE_LIMIT_CANCELLATION_PERIOD || "1h") as "1h",
  },
};

// ============================================================================
// RETRY CONFIGURATIONS
// ============================================================================

export const RETRY_CONFIGS = {
  DEFAULT: envInt("RETRY_DEFAULT", 5),
  CRITICAL: envInt("RETRY_CRITICAL", 10),
  LOW_PRIORITY: envInt("RETRY_LOW_PRIORITY", 3),
  STANDARD: envInt("RETRY_STANDARD", 5),
  CRON: envInt("RETRY_CRON", 3),
};

// ============================================================================
// BACKORDER CONFIGURATIONS
// ============================================================================

export const BACKORDER_CONFIGS = {
  // Max retry attempts before escalation (spock-store uses 7 days)
  maxRetries: envInt("BACKORDER_MAX_RETRIES", 7),
  // Hours between retry attempts
  retryIntervalHours: envInt("BACKORDER_RETRY_INTERVAL_HOURS", 24),
  // Max days before auto-cancel
  maxDaysBeforeCancel: envInt("BACKORDER_MAX_DAYS", 30),
  // Timeout for step.waitForEvent (how long to wait for stock replenishment event)
  waitForEventTimeoutHours: envInt("BACKORDER_WAIT_TIMEOUT_HOURS", 48),
  // Feature flag for backorder retry
  enabled: process.env.BACKORDER_RETRY_ENABLED !== "false",
};
