// ============================================================================
// IM8 BATTLE BUS - CONFIGURATION
// ============================================================================
// Environment-based configuration for all integrations

export const config = {
  // Dynamics 365 Configuration
  dynamics: {
    baseUrl: process.env.D365_BASE_URL || "",
    tenantId: process.env.D365_TENANT_ID || "",
    clientId: process.env.D365_CLIENT_ID || "",
    clientSecret: process.env.D365_CLIENT_SECRET || "",
    // OAuth2 scope for D365 (v2.0 endpoint)
    scope: process.env.D365_SCOPE || `${process.env.D365_BASE_URL}/.default`,
    // Legacy resource for v1.0 endpoint (if needed)
    resource: process.env.D365_RESOURCE || "",
    dataAreaId: process.env.D365_DATA_AREA_ID || "U001",
  },

  // GPS Warehouse Configuration
  // Uses authcode query param with sorted-key HMAC
  gps: {
    baseUrl: process.env.GPS_BASE_URL || "https://api.xlwms.com",
    apiKey: process.env.GPS_API_KEY || "",
    apiSecret: process.env.GPS_API_SECRET || "",
    warehouseCode: process.env.GPS_WAREHOUSE_CODE || "JFK01W",
  },

  // STORD Warehouse Configuration
  stord: {
    baseUrl: process.env.STORD_BASE_URL || "",
    apiKey: process.env.STORD_API_KEY || "",
    organizationId: process.env.STORD_ORGANIZATION_ID || "",
  },

  // Shopify Configuration (IM8 Store)
  shopify: {
    im8: {
      shopDomain: process.env.SHOPIFY_IM8_SHOP_DOMAIN || "",
      accessToken: process.env.SHOPIFY_IM8_ACCESS_TOKEN || "",
      apiVersion: process.env.SHOPIFY_API_VERSION || "2024-07",
      webhookSecret: process.env.SHOPIFY_IM8_WEBHOOK_SECRET || "",
    },
  },

  // Feature Flags
  features: {
    enableDynamicsSync: process.env.ENABLE_DYNAMICS_SYNC !== "false",
    enableGpsSync: process.env.ENABLE_GPS_SYNC !== "false",
    enableStordSync: process.env.ENABLE_STORD_SYNC !== "false",
    dryRunMode: process.env.DRY_RUN_MODE === "true",
  },

  // Retry Configuration
  retry: {
    maxAttempts: parseInt(process.env.RETRY_MAX_ATTEMPTS || "5", 10),
    backoffMs: parseInt(process.env.RETRY_BACKOFF_MS || "60000", 10),
    maxBackoffMs: parseInt(process.env.RETRY_MAX_BACKOFF_MS || "3600000", 10),
  },

  // Order Processing Delays
  delays: {
    orderSyncDelayMinutes: parseInt(
      process.env.ORDER_SYNC_DELAY_MINUTES || "5",
      10
    ),
    outOfStockRetryHours: parseInt(
      process.env.OOS_RETRY_HOURS || "4",
      10
    ),
  },

  // Slack config
  slack: {
    applicationName: 'store',
    appEnv: 'local',
    integration: 'real',
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
    }
  },
} as const;

// Validate required configuration
export function validateConfig(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (config.features.enableDynamicsSync) {
    if (!config.dynamics.baseUrl) errors.push("D365_BASE_URL is required");
    if (!config.dynamics.tenantId) errors.push("D365_TENANT_ID is required");
    if (!config.dynamics.clientId) errors.push("D365_CLIENT_ID is required");
    if (!config.dynamics.clientSecret)
      errors.push("D365_CLIENT_SECRET is required");
  }

  if (config.features.enableGpsSync) {
    if (!config.gps.baseUrl) errors.push("GPS_BASE_URL is required");
    if (!config.gps.apiKey) errors.push("GPS_API_KEY is required");
    if (!config.gps.apiSecret) errors.push("GPS_API_SECRET is required");
  }

  if (!config.shopify.im8.accessToken) {
    errors.push("SHOPIFY_IM8_ACCESS_TOKEN is required");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
