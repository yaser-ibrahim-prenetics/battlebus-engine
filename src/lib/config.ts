// ============================================================================
// IM8 BATTLE BUS - CONFIGURATION
// ============================================================================
// Environment-based configuration for all integrations

export const config = {
  // Dynamics 365 Configuration
  dynamics: {
    baseUrl: process.env.D365_BASE_URL || "https://p-uat.sandbox.operations.dynamics.com",
    tenantId: process.env.D365_TENANT_ID || "fdea3f0c-62d4-40b7-bb83-017d9e8f6bd7",
    clientId: process.env.D365_CLIENT_ID || "740f1eb2-8f38-4c57-8150-81836a399a8e",
    clientSecret: process.env.D365_CLIENT_SECRET || "dEP8Q~WmFC9TWibaH3~rETToqmZDeh666zYEqcA3",
    scope: process.env.D365_SCOPE || (process.env.D365_BASE_URL ? `${process.env.D365_BASE_URL}/.default` : "https://p-uat.sandbox.operations.dynamics.com/.default"),
    resource: process.env.D365_RESOURCE || "",
    dataAreaId: process.env.D365_DATA_AREA_ID || "U001",
  },

  // GPS Warehouse Configuration (US)
  gps: {
    baseUrl: process.env.GPS_BASE_URL || "https://api.xlwms.com",
    apiKey: process.env.GPS_API_KEY || "9d093e6f60af4e5d8d01f22ee5bb9353",
    apiSecret: process.env.GPS_API_SECRET || "4cf5d93e0b97455a99f85cb5dfd5cf02",
    warehouseCode: process.env.GPS_WAREHOUSE_CODE || "JFK01W",
    // Polling settings
    scheduleIntervalMinutes: parseInt(process.env.GPS_SCHEDULE_INTERVAL_MINUTES || "60", 10),
    queryDaysBack: parseInt(process.env.GPS_QUERY_DAYS_BACK || "7", 10),
    batchSize: parseInt(process.env.GPS_BATCH_SIZE || "50", 10),
    gpsFulfilledStatus: 3,
    // Fulfillment sync settings
    fulfillmentHoursBack: parseInt(process.env.GPS_FULFILLMENT_HOURS_BACK || "80", 10),
  },

  // GPS UK Warehouse Configuration
  gpsUk: {
    baseUrl: process.env.GPS_UK_BASE_URL || process.env.GPS_BASE_URL || "https://api.xlwms.com",
    apiKey: process.env.GPS_UK_API_KEY || "ac24ea540f0c4a0681814a5bfd0eb644",
    apiSecret: process.env.GPS_UK_API_SECRET || "8e3bf78a75c54a01a621879790446a35",
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
    baseUrl: process.env.EXTENSIV_BASE_URL || "https://box.secure-wms.com",
    enabled: process.env.EXTENSIV_ENABLED !== "false", // Default to true, set to "false" to disable
    disableWebhookVerification: process.env.DISABLE_EXTENSIV_WEBHOOK_VERIFICATION === "true",
    warehouse: {
      charlotte: {
        name: "Charlotte Warehouse",
        grantType: "client_credentials",
        clientId: process.env.EXTENSIV_CHARLOTTE_CLIENT_ID || "91ade825-a716-478b-9806-a484b613042a",
        clientSecret: process.env.EXTENSIV_CHARLOTTE_CLIENT_SECRET || "Ll8c3Oswbhggog1Pu2x5+9QbhS259C0r",
        userLoginId: process.env.EXTENSIV_CHARLOTTE_USER_LOGIN_ID || "261",
        customerIdentifier: parseInt(process.env.EXTENSIV_CHARLOTTE_CUSTOMER_ID || "53", 10),
        facilityIdentifier: parseInt(process.env.EXTENSIV_CHARLOTTE_FACILITY_ID || "2", 10),
      },
    },
  },

  // Shopify Configuration (IM8 Store)
  shopify: {
    im8: {
      shopDomain: process.env.SHOPIFY_IM8_SHOP_DOMAIN || "testing-im8store.myshopify.com",
      accessToken: process.env.SHOPIFY_IM8_ACCESS_TOKEN || "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",
      apiVersion: process.env.SHOPIFY_API_VERSION || "2024-07",
      webhookSecret: process.env.SHOPIFY_IM8_WEBHOOK_SECRET || "95729db9968a6f279abb9e64a04db8ffea61682940db7314aa208f9a8749e8f0",
      // Location IDs for routing fulfillment
      locations: {
        gps: process.env.SHOPIFY_LOCATION_GPS || "79527313640",
        gpsUk: process.env.SHOPIFY_LOCATION_GPS_UK || "82997936360",
        stord: process.env.SHOPIFY_LOCATION_STORD || "",
        hkWarehouse: process.env.SHOPIFY_LOCATION_HK || "",
      },
    },
    enabledRiskCheck: true,
  },

  // CS Platform (Battle Hub) Configuration
  csPlatform: {
    baseUrl: process.env.CS_PLATFORM_URL || process.env.BATTLE_CS_URL || "https://battle-hub-three.vercel.app",
    // HMAC secret for webhook signature verification
    // Must match BATTLE_BUS_WEBHOOK_SECRET in battle-cs platform
    webhookSecret: process.env.CS_PLATFORM_WEBHOOK_SECRET || "e3221dc7cc4dd5aac7053df6bd8d094b9c148053cae5696a64d351bf35b1ab5b",
    enabled: process.env.CS_PLATFORM_ENABLED !== "false", // Default to true, set to "false" to disable
  },

  // Slack Notification Channels
   slack: {
    applicationName: 'store',
    appEnv: 'local',
    integration: 'real',
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
    maxAttempts: parseInt(process.env.RETRY_MAX_ATTEMPTS || "5", 10),
    backoffMs: parseInt(process.env.RETRY_BACKOFF_MS || "60000", 10),
    maxBackoffMs: parseInt(process.env.RETRY_MAX_BACKOFF_MS || "3600000", 10),
  },

  // Order Processing Delays
  delays: {
    orderSyncDelayMinutes: parseInt(process.env.ORDER_SYNC_DELAY_MINUTES || "5", 10),
    outOfStockRetryHours: parseInt(process.env.OOS_RETRY_HOURS || "4", 10),
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
      console.warn("CS_PLATFORM_WEBHOOK_SECRET is not set - webhooks will be sent without signature verification");
    }
  }

  return { valid: errors.length === 0, errors };
}
