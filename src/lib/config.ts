// ============================================================================
// IM8 BATTLE BUS - CONFIGURATION
// ============================================================================
// Environment-based configuration for all integrations

function safeParseInt(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

export const config = {
  // Dynamics 365 Configuration
  dynamics: {
    baseUrl: process.env.D365_BASE_URL || "",
    tenantId: process.env.D365_TENANT_ID || "",
    clientId: process.env.D365_CLIENT_ID || "",
    clientSecret: process.env.D365_CLIENT_SECRET || "",
    scope:
      process.env.D365_SCOPE ||
      (process.env.D365_BASE_URL
        ? `${process.env.D365_BASE_URL}/.default`
        : ""),
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
    queryDaysBack: safeParseInt(process.env.GPS_QUERY_DAYS_BACK, 7),
    batchSize: safeParseInt(process.env.GPS_BATCH_SIZE, 50),
    gpsFulfilledStatus: 3,
    fulfillmentHoursBack: safeParseInt(process.env.GPS_FULFILLMENT_HOURS_BACK, 80),
    inventorySyncIntervalMinutes: safeParseInt(
      process.env.GPS_INVENTORY_SYNC_INTERVAL_MINUTES, 120
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

  // Extensiv (3PL Central) Warehouse Configuration
  extensiv: {
    baseUrl: process.env.EXTENSIV_BASE_URL || "",
    enabled: process.env.EXTENSIV_ENABLED !== "false",
    disableWebhookVerification: process.env.DISABLE_EXTENSIV_WEBHOOK_VERIFICATION === "true",
    warehouse: {
      charlotte: {
        name: "Charlotte Warehouse",
        grantType: "client_credentials",
        clientId: process.env.EXTENSIV_CHARLOTTE_CLIENT_ID || "",
        clientSecret: process.env.EXTENSIV_CHARLOTTE_CLIENT_SECRET || "",
        userLoginId: process.env.EXTENSIV_CHARLOTTE_USER_LOGIN_ID || "",
        customerIdentifier: safeParseInt(process.env.EXTENSIV_CHARLOTTE_CUSTOMER_ID, 0),
        facilityIdentifier: safeParseInt(process.env.EXTENSIV_CHARLOTTE_FACILITY_ID, 0),
      },
    },
  },

  // Shopify Configuration (IM8 Store)
  shopify: {
    im8: {
      shopDomain: process.env.SHOPIFY_IM8_SHOP_DOMAIN || "",
      accessToken: process.env.SHOPIFY_IM8_ACCESS_TOKEN || "",
      apiVersion: process.env.SHOPIFY_API_VERSION || "2024-07",
      webhookSecret: process.env.SHOPIFY_IM8_WEBHOOK_SECRET || "",
      // Location IDs — prefer Hub/Supabase location-routing over these env fallbacks
      locations: {
        gps: process.env.SHOPIFY_LOCATION_GPS || "",
        gpsUk: process.env.SHOPIFY_LOCATION_GPS_UK || "",
        stord: process.env.SHOPIFY_LOCATION_STORD || "",
        hkWarehouse: process.env.SHOPIFY_LOCATION_HK || "",
      },
    },
    enabledRiskCheck: true,
  },

  // CS Platform (Battle Hub) Configuration
  csPlatform: {
    baseUrl:
      process.env.CS_PLATFORM_URL ||
      process.env.BATTLE_CS_URL ||
      "",
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
      extensiv: process.env.SLACK_EXTENSIV_CHANNEL,
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
    enableExtensivSync: process.env.ENABLE_EXTENSIV_SYNC !== "false",
    dryRunMode: process.env.DRY_RUN_MODE === "true",
    skipHighRiskOrders: process.env.SKIP_HIGH_RISK_ORDERS !== "false",
    skipTestOrders: process.env.SKIP_TEST_ORDERS !== "false",
    // GPS fulfillment simulation: when enabled, scheduler will process simulated fulfillments
    enableGpsFulfillmentSimulation: process.env.ENABLE_GPS_FULFILLMENT_SIMULATION === "true",
    enabledShopifyRiskCheck: false,
    enabledShopifyRiskMock: false,
    enabledShopifyOrderMock: false,
    enabledShopifyCreateFulfillmentMock: false,
    enabledGpsOutboundMock: false,
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
    if (!config.gps.apiKey) errors.push("GPS_API_KEY is required");
    if (!config.gps.apiSecret) errors.push("GPS_API_SECRET is required");

    if (process.env.GPS_UK_API_KEY && !process.env.GPS_UK_API_SECRET) {
      errors.push("GPS_UK_API_SECRET is required if GPS_UK_API_KEY is set");
    }
  }

  if (config.features.enableExtensivSync && config.extensiv.enabled) {
    if (!config.extensiv.warehouse.charlotte.clientId) {
      errors.push("EXTENSIV_CHARLOTTE_CLIENT_ID is required when Extensiv is enabled");
    }
    if (!config.extensiv.warehouse.charlotte.clientSecret) {
      errors.push("EXTENSIV_CHARLOTTE_CLIENT_SECRET is required when Extensiv is enabled");
    }
  }

  if (!config.shopify.im8.accessToken) {
    errors.push("SHOPIFY_IM8_ACCESS_TOKEN is required");
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
