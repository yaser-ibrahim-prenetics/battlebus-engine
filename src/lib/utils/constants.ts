// ============================================================================
// FUNCTION CONSTANTS
// ============================================================================
// Shared constants for Inngest functions
// All values are configurable via environment variables with sensible defaults

// Helper to safely parse int from env with fallback (NaN-safe)
function safeParseInt(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

const envInt = (key: string, fallback: number): number =>
  safeParseInt(process.env[key], fallback);

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
// Inngest accepts retries as 0-20 (literal union). Clamp env values and cast.
type InngestRetries =
  | 0
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12
  | 13
  | 14
  | 15
  | 16
  | 17
  | 18
  | 19
  | 20;
const clampRetries = (n: number): InngestRetries => Math.min(20, Math.max(0, n)) as InngestRetries;

export const RETRY_CONFIGS = {
  DEFAULT: clampRetries(envInt("RETRY_DEFAULT", 5)),
  CRITICAL: clampRetries(envInt("RETRY_CRITICAL", 10)),
  LOW_PRIORITY: clampRetries(envInt("RETRY_LOW_PRIORITY", 3)),
  STANDARD: clampRetries(envInt("RETRY_STANDARD", 5)),
  CRON: clampRetries(envInt("RETRY_CRON", 3)),
};

// ============================================================================
// BACKORDER CONFIGURATIONS
// ============================================================================

// ============================================================================
// STEP-LEVEL RETRY WITH BACKOFF HELPER
// ============================================================================
// Use this inside an Inngest step.run() to retry a downstream API call
// with exponential backoff before throwing and letting Inngest retry the step.

export interface RetryWithBackoffOptions {
  /** Human-readable label for logs */
  label: string;
  /** Max attempts *within* this single step execution (not Inngest retries) */
  maxAttempts?: number;
  /** Base delay in ms (doubles each attempt) */
  baseDelayMs?: number;
  /** Maximum delay cap in ms */
  maxDelayMs?: number;
  /** Which HTTP status codes to retry on (in addition to network errors) */
  retryableStatuses?: number[];
  /** Optional classifier to skip retries for known non-transient errors */
  shouldRetry?: (error: unknown) => boolean;
}

const DEFAULT_RETRY_OPTS: Required<Omit<RetryWithBackoffOptions, "label">> = {
  maxAttempts: 3,
  baseDelayMs: envInt("STEP_BACKOFF_BASE_MS", 500),
  maxDelayMs: envInt("STEP_BACKOFF_MAX_MS", 8000),
  retryableStatuses: [429, 500, 502, 503, 504],
  shouldRetry: () => true,
};

/**
 * Retry a function call with exponential backoff.
 * Meant to be called *inside* a `step.run()` to handle transient downstream failures
 * before the error propagates up to Inngest's function-level retry.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: RetryWithBackoffOptions
): Promise<T> {
  const {
    maxAttempts = DEFAULT_RETRY_OPTS.maxAttempts,
    baseDelayMs = DEFAULT_RETRY_OPTS.baseDelayMs,
    maxDelayMs = DEFAULT_RETRY_OPTS.maxDelayMs,
    shouldRetry,
  } = opts;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      if (shouldRetry && !shouldRetry(err)) {
        throw err;
      }
      if (attempt === maxAttempts) break;

      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      console.warn(
        `[RetryBackoff] ${opts.label} attempt ${attempt}/${maxAttempts} failed: ${err?.message || err}. Retrying in ${delay}ms…`
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastError;
}

// ============================================================================
// TAG WAIT FEATURE FLAG
// ============================================================================
// Controls the 5-minute delay after order creation to wait for Shopify tags.
// Set TAG_WAIT_ENABLED=false to disable (useful in test environments or reruns).
// TAG_WAIT_DURATION accepts Inngest step.sleep duration strings (e.g. "5m", "2m").

export const TAG_WAIT_ENABLED = process.env.TAG_WAIT_ENABLED !== "false";
export const TAG_WAIT_DURATION = process.env.TAG_WAIT_DURATION || "5m";

// ============================================================================
// SUBSCRIPTION TAG WAIT
// ============================================================================
// How long to wait for Skio to apply subscription tags before proceeding.
// Reduced from 15m to 5m — if tags aren't applied, process anyway and alert.
export const SUBSCRIPTION_TAG_WAIT_MINUTES = envInt('SUBSCRIPTION_TAG_WAIT_MINUTES', 5);
export const SUBSCRIPTION_TAG_WAIT_WARN_ENABLED = process.env.SUBSCRIPTION_TAG_WAIT_WARN !== 'false';

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
  // Auto-retry: opt-in automatic retry (default: manual-only)
  // Set BACKORDER_AUTO_RETRY_ENABLED=true to enable scheduled auto-retries
  autoRetryEnabled: process.env.BACKORDER_AUTO_RETRY_ENABLED === "true",
  autoRetryIntervalHours: envInt("BACKORDER_AUTO_RETRY_INTERVAL_HOURS", 12),
  autoRetryMaxAttempts: envInt("BACKORDER_AUTO_RETRY_MAX_ATTEMPTS", 3),
};
