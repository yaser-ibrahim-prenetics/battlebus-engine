// ============================================================================
// IM8 BATTLE BUS - CONFIGURATION
// ============================================================================
// Environment-based configuration for all integrations

function safeParseInt(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ---------------------------------------------------------------------------
// Shopify store mode — selects SHOPIFY_PROD_* vs SHOPIFY_TEST_* only.
// D365 and GPS always use the single D365_* / GPS_* / GPS_UK_* env var sets.
//
// Resolution: SHOPIFY_STORE_MODE → else NODE_ENV (production vs test).
// On Vercel Preview, set SHOPIFY_STORE_MODE=test explicitly (NODE_ENV is often production).
// ---------------------------------------------------------------------------
const shopifyStoreMode: "production" | "test" =
  process.env.SHOPIFY_STORE_MODE === "production"
    ? "production"
    : process.env.SHOPIFY_STORE_MODE === "test"
      ? "test"
      : process.env.NODE_ENV === "production"
        ? "production"
        : "test";

const _shopifyProd = {
  shopDomain: process.env.SHOPIFY_PROD_SHOP_DOMAIN || "",
  accessToken: process.env.SHOPIFY_PROD_ACCESS_TOKEN || "",
  apiVersion: process.env.SHOPIFY_PROD_API_VERSION || process.env.SHOPIFY_API_VERSION || "2024-07",
  webhookSecret: process.env.SHOPIFY_PROD_WEBHOOK_SECRET || "",
  locations: {
    gps: process.env.SHOPIFY_PROD_LOCATION_GPS || "",
    gpsUk: process.env.SHOPIFY_PROD_LOCATION_GPS_UK || "",
    stord: process.env.SHOPIFY_PROD_LOCATION_STORD || "",
    hkWarehouse: process.env.SHOPIFY_PROD_LOCATION_HK || "",
  },
};

const _shopifyTest = {
  shopDomain: process.env.SHOPIFY_TEST_SHOP_DOMAIN || "",
  accessToken: process.env.SHOPIFY_TEST_ACCESS_TOKEN || "",
  apiVersion: process.env.SHOPIFY_TEST_API_VERSION || process.env.SHOPIFY_API_VERSION || "2024-07",
  webhookSecret: process.env.SHOPIFY_TEST_WEBHOOK_SECRET || "",
  locations: {
    gps: process.env.SHOPIFY_TEST_LOCATION_GPS || "",
    gpsUk: process.env.SHOPIFY_TEST_LOCATION_GPS_UK || "",
    stord: process.env.SHOPIFY_TEST_LOCATION_STORD || "",
    hkWarehouse: process.env.SHOPIFY_TEST_LOCATION_HK || "",
  },
};

/** Active Shopify credentials — resolved from SHOPIFY_STORE_MODE / NODE_ENV. */
const _shopifyActive = shopifyStoreMode === "production" ? _shopifyProd : _shopifyTest;

export const config = {
  // Dynamics 365 Configuration (single env set)
  dynamics: {
    baseUrl: process.env.D365_BASE_URL || "",
    tenantId: process.env.D365_TENANT_ID || "",
    clientId: process.env.D365_CLIENT_ID || "",
    clientSecret: process.env.D365_CLIENT_SECRET || "",
    scope:
      process.env.D365_SCOPE ||
      (process.env.D365_BASE_URL ? `${process.env.D365_BASE_URL}/.default` : ""),
    resource: process.env.D365_RESOURCE || "",
    dataAreaId: process.env.D365_DATA_AREA_ID || "U001",
  },

  // GPS Warehouse Configuration (US)
  gps: {
    baseUrl: process.env.GPS_BASE_URL || "",
    apiKey: process.env.GPS_API_KEY || "",
    apiSecret: process.env.GPS_API_SECRET || "",
    warehouseCode: process.env.GPS_WAREHOUSE_CODE || "JFK01W",
    scheduleIntervalMinutes: safeParseInt(process.env.GPS_SCHEDULE_INTERVAL_MINUTES, 60),
    /** How many days of orders to include when polling for GPS fulfillment (Supabase + Shopify fallback). */
    fulfillmentPollDaysBack: clampInt(
      safeParseInt(
        process.env.GPS_FULFILLMENT_POLL_DAYS_BACK ||
          process.env.GPS_QUERY_DAYS_BACK /* legacy name */,
        30
      ),
      1,
      365
    ),
    batchSize: safeParseInt(process.env.GPS_BATCH_SIZE, 50),
    gpsFulfilledStatus: 3,
    fulfillmentHoursBack: safeParseInt(process.env.GPS_FULFILLMENT_HOURS_BACK, 80),
    inventorySyncIntervalMinutes: safeParseInt(
      process.env.GPS_INVENTORY_SYNC_INTERVAL_MINUTES,
      120
    ),
  },

  // GPS UK Warehouse Configuration
  gpsUk: {
    baseUrl: process.env.GPS_UK_BASE_URL || process.env.GPS_BASE_URL || "",
    apiKey: process.env.GPS_UK_API_KEY || "",
    apiSecret: process.env.GPS_UK_API_SECRET || "",
    warehouseCode: process.env.GPS_UK_WAREHOUSE_CODE || "LHR",
  },

  // STORD Warehouse Configuration
  stord: {
    baseUrl: process.env.STORD_BASE_URL || "",
    apiKey: process.env.STORD_API_KEY || "",
    organizationId: process.env.STORD_ORGANIZATION_ID || "",
  },

  // Shopify Configuration (IM8 Store)
  // Active credentials are selected by SHOPIFY_STORE_MODE (production | test).
  shopify: {
    storeMode: shopifyStoreMode,
    /** Resolved active store — all API clients use this. */
    im8: _shopifyActive,
    /** Full production credential set — available for explicit cross-env calls. */
    production: _shopifyProd,
    /** Full test credential set — available for explicit cross-env calls. */
    test: _shopifyTest,
    enabledRiskCheck: true,
  },

  // CS Platform (Battle Hub) Configuration
  csPlatform: {
    baseUrl: process.env.CS_PLATFORM_URL || process.env.BATTLE_CS_URL || "",
    webhookSecret: process.env.CS_PLATFORM_WEBHOOK_SECRET || "",
    enabled: process.env.CS_PLATFORM_ENABLED !== "false",
  },

  // PayPal Tracking Configuration
  paypal: {
    clientId: process.env.PAYPAL_CLIENT_ID || "",
    clientSecret: process.env.PAYPAL_CLIENT_SECRET || "",
    mode: (process.env.PAYPAL_MODE || "sandbox") as "sandbox" | "live",
    enabled: process.env.PAYPAL_ENABLED === "true", // Default: false - must explicitly enable
  },

  // Slack Notification Channels
  slack: {
    applicationName: "store",
    appEnv: "local",
    integration: "real",
    enabledRiskCheck: process.env.ENABLE_SLACK_RISK_CHECK === "true",
    channel: {
      order: process.env.SLACK_ORDER_CHANNEL,
      general: process.env.SLACK_GENERAL_CHANNEL,
      europa: process.env.SLACK_EUROPA_CHANNEL,
      system: process.env.SLACK_SYSTEM_CHANNEL,
      shopify: process.env.SLACK_SHOPIFY_CHANNEL,
      shopifylow: process.env.SLACK_SHOPIFY_FLOW_CHANNEL,
      prive: process.env.SLACK_PRIVE_CHANNEL,
      loop: process.env.SLACK_LOOP_CHANNEL,
      dynamics: process.env.SLACK_DYNAMICS_CHANNEL,
      circledna: process.env.SLACK_CIRCLEDNA_CHANNEL,
      circlednaorder: process.env.SLACK_CIRCLE_DNA_ORDER_CHANNEL,
      gps: process.env.SLACK_GPS_CHANNEL,
      gpslow: process.env.SLACK_GPS_LOW_CHANNEL,
      stord: process.env.SLACK_STORD_CHANNEL,
    },
  },

  // Feature Flags
  features: {
    enableDynamicsSync: process.env.ENABLE_DYNAMICS_SYNC !== "false", // Default: true (set ENABLE_DYNAMICS_SYNC=false to disable)
    enableGpsSync: process.env.ENABLE_GPS_SYNC === "true", // Default: false - must explicitly set "true" to enable
    enableStordSync: process.env.ENABLE_STORD_SYNC !== "false",
    dryRunMode: process.env.DRY_RUN_MODE === "true",
    skipHighRiskOrders: process.env.SKIP_HIGH_RISK_ORDERS !== "false",
    skipTestOrders: process.env.SKIP_TEST_ORDERS !== "false",
    // GPS fulfillment simulation: when enabled, scheduler will process simulated fulfillments
    enableGpsFulfillmentSimulation: process.env.ENABLE_GPS_FULFILLMENT_SIMULATION === "true",
    /**
     * Explicit opt-in for Shopify fulfillment writeback from GPS flows.
     *
     * Safe default is OFF to avoid accidental writes to production Shopify
     * during method-2 testing. GPS flows will still continue with D365 sync and
     * internal events, but won't call Shopify createFulfillment unless this is
     * explicitly set to true.
     */
    enableShopifyFulfillmentWriteback: process.env.ENABLE_SHOPIFY_FULFILLMENT_WRITEBACK === "true",
    enabledShopifyRiskCheck: false,
    enabledShopifyRiskMock: false,
    enabledShopifyOrderMock: false,
    enabledShopifyCreateFulfillmentMock: false,
    /**
     * Master kill-switch for registering inventory-related Inngest functions.
     * Default OFF so inventory jobs do not run unless explicitly enabled.
     */
    enableInventoryRuns: process.env.ENABLE_INVENTORY_RUNS === "true",
    /**
     * Cross-system inventory pushes (Shopify ↔ D365 ↔ GPS mesh, webhooks, full sync).
     * Default OFF unless explicitly enabled.
     */
    enableInventorySync: process.env.ENABLE_INVENTORY_SYNC === "true",
    /**
     * Controls the scheduled product inventory reconciliation cron only.
     * Manual inventory reconciliation endpoints/events remain available.
     */
    enableProductInventorySyncCron:
      process.env.ENABLE_PRODUCT_INVENTORY_SYNC_CRON === "true",
    enabledGpsOutboundMock: false,
    /**
     * Explicitly post a D365 return-order invoice (credit note) after the `type: "return"`
     * fulfilment. Default `false` — in the standard THK tenant the return fulfilment already
     * generates the credit note, so calling `postReturnOrderInvoice` is redundant and can
     * double-post. Enable only for tenants that require the explicit action.
     */
    enableReturnInvoicePosting: process.env.ENABLE_RETURN_INVOICE_POSTING === "true",
  },

  // Retry Configuration
  retry: {
    maxAttempts: safeParseInt(process.env.RETRY_MAX_ATTEMPTS, 5),
    backoffMs: safeParseInt(process.env.RETRY_BACKOFF_MS, 60000),
    maxBackoffMs: safeParseInt(process.env.RETRY_MAX_BACKOFF_MS, 3600000),
  },

  // Order Processing Delays
  delays: {
    orderSyncDelayMinutes: safeParseInt(process.env.ORDER_SYNC_DELAY_MINUTES, 5),
    outOfStockRetryHours: safeParseInt(process.env.OOS_RETRY_HOURS, 4),
  },

  // Backorder Queue Configuration
  backorder: {
    enabled: process.env.BACKORDER_RETRY_ENABLED !== "false",
    maxRetries: safeParseInt(process.env.BACKORDER_MAX_RETRIES, 7),
    retryIntervalHours: safeParseInt(process.env.BACKORDER_RETRY_INTERVAL_HOURS, 24),
    maxDaysBeforeCancel: safeParseInt(process.env.BACKORDER_MAX_DAYS, 30),
    waitForEventTimeoutHours: safeParseInt(process.env.BACKORDER_WAIT_TIMEOUT_HOURS, 48),
  },

  // Pending lifecycle action drain sweep
  pendingActions: {
    // 1-59 minutes (default 10). This powers the cron schedule for drain-pending-actions.
    drainIntervalMinutes: clampInt(
      safeParseInt(process.env.PENDING_ACTIONS_DRAIN_INTERVAL_MINUTES, 10),
      1,
      59
    ),
  },

  // Order validation
  orders: {
    liveDateTime: process.env.ORDERS_LIVE_DATE || "2024-11-17T13:22:00-05:00",
    testTags: ["testing", "load-testing"],
    highRiskTag: "high-risk-order",
    dummySkuPatterns: ["DUMMY", "TEST-SKU"],
  },
} as const;

// GPS Fulfilled Status Constants
export const GPS_STATUS = {
  PENDING: 1,
  PROCESSING: 2,
  FULFILLED: 3,
  CANCELLED: 4,
} as const;

// Validate required configuration
export function validateConfig(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (config.features.enableDynamicsSync) {
    if (!config.dynamics.baseUrl) errors.push("D365_BASE_URL is required");
    if (!config.dynamics.tenantId) errors.push("D365_TENANT_ID is required");
    if (!config.dynamics.clientId) errors.push("D365_CLIENT_ID is required");
    if (!config.dynamics.clientSecret) errors.push("D365_CLIENT_SECRET is required");
  }

  if (config.features.enableGpsSync) {
    if (!config.gps.baseUrl) errors.push("GPS_BASE_URL is required");
    if (!config.gps.apiKey) errors.push("GPS_API_KEY is required (US warehouse credentials)");
    if (!config.gps.apiSecret) errors.push("GPS_API_SECRET is required (US warehouse credentials)");

    if (!config.gpsUk.apiKey)
      errors.push(
        "GPS_UK_API_KEY is required (UK warehouse credentials — must differ from GPS_API_KEY)"
      );
    if (!config.gpsUk.apiSecret)
      errors.push("GPS_UK_API_SECRET is required (UK warehouse credentials)");

    if (config.gps.apiKey && config.gpsUk.apiKey && config.gps.apiKey === config.gpsUk.apiKey) {
      console.warn(
        "[Config] WARNING: GPS_API_KEY and GPS_UK_API_KEY are identical. " +
          "Each GPS warehouse usually has its own appKey — verify this is intentional."
      );
    }
  }

  if (!config.shopify.im8.accessToken) {
    const modeVar =
      config.shopify.storeMode === "production"
        ? "SHOPIFY_PROD_ACCESS_TOKEN"
        : "SHOPIFY_TEST_ACCESS_TOKEN";
    errors.push(`${modeVar} is required (active SHOPIFY_STORE_MODE="${config.shopify.storeMode}")`);
  }

  if (!config.shopify.im8.shopDomain) {
    const modeVar =
      config.shopify.storeMode === "production"
        ? "SHOPIFY_PROD_SHOP_DOMAIN"
        : "SHOPIFY_TEST_SHOP_DOMAIN";
    errors.push(`${modeVar} is required (active SHOPIFY_STORE_MODE="${config.shopify.storeMode}")`);
  }

  if (config.csPlatform.enabled) {
    if (!config.csPlatform.baseUrl) {
      errors.push("CS_PLATFORM_URL or BATTLE_CS_URL is required when CS Platform is enabled");
    }
    if (!config.csPlatform.webhookSecret) {
      console.warn(
        "CS_PLATFORM_WEBHOOK_SECRET is not set - webhooks will be sent without signature verification"
      );
    }
  }

  return { valid: errors.length === 0, errors };
}
