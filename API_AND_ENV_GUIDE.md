# API & Environment Configuration Guide

## Environment Variables

### Dynamics 365 (Finance & Operations)
Required for syncing orders, inventory, and fulfillments.

| Variable | Description | Example |
|----------|-------------|---------|
| `D365_BASE_URL` | Base URL for D365 instance | `https://your-org.operations.dynamics.com` |
| `D365_TENANT_ID` | Azure AD Tenant ID | `uuid-string` |
| `D365_CLIENT_ID` | App Registration Client ID | `uuid-string` |
| `D365_CLIENT_SECRET` | App Registration Client Secret | `secret-string` |
| `D365_SCOPE` | OAuth2 Scope | `https://your-org.operations.dynamics.com/.default` |
| `D365_DATA_AREA_ID` | Default Legal Entity | `U001` |

### GPS Warehouse (US)
Required for US fulfillment via GPS.

| Variable | Description | Example |
|----------|-------------|---------|
| `GPS_BASE_URL` | GPS API Base URL | `https://api.xlwms.com` |
| `GPS_API_KEY` | App Key for US account | `your-app-key` |
| `GPS_API_SECRET` | App Secret for US account | `your-app-secret` |
| `GPS_WAREHOUSE_CODE` | Warehouse Code | `JFK01W` |
| `GPS_SCHEDULE_INTERVAL_MINUTES` | Polling Interval (min) | `60` |
| `GPS_QUERY_DAYS_BACK` | Lookback period (days) | `7` |
| `GPS_BATCH_SIZE` | API Batch Size | `50` |

### GPS UK Warehouse
Required for UK/EU fulfillment via GPS.

| Variable | Description | Example |
|----------|-------------|---------|
| `GPS_UK_BASE_URL` | GPS UK API Base URL (usually same as US) | `https://api.xlwms.com` |
| `GPS_UK_API_KEY` | App Key for UK account | `your-uk-app-key` |
| `GPS_UK_API_SECRET` | App Secret for UK account | `your-uk-app-secret` |
| `GPS_UK_WAREHOUSE_CODE` | Warehouse Code | `LHR` |

### STORD Warehouse
Required for STORD fulfillment sync.

| Variable | Description | Example |
|----------|-------------|---------|
| `STORD_BASE_URL` | STORD API Base URL | `https://api.stord.com` |
| `STORD_API_KEY` | API Key | `your-stord-key` |
| `STORD_ORGANIZATION_ID` | Organization ID | `your-org-id` |

### Shopify (IM8 Store)
Required for reading orders and updating fulfillments.

| Variable | Description | Example |
|----------|-------------|---------|
| `SHOPIFY_IM8_SHOP_DOMAIN` | Shop Domain | `im8-health.myshopify.com` |
| `SHOPIFY_IM8_ACCESS_TOKEN` | Admin API Access Token | `shpat_...` |
| `SHOPIFY_API_VERSION` | API Version | `2024-07` |
| `SHOPIFY_IM8_WEBHOOK_SECRET` | Webhook Signing Secret | `shpss_...` |

### Shopify Location IDs
Used to route fulfillment logic based on assigned location.

| Variable | Description | Example |
|----------|-------------|---------|
| `SHOPIFY_LOCATION_GPS` | GPS US Location ID | `1234567890` |
| `SHOPIFY_LOCATION_GPS_UK` | GPS UK Location ID | `0987654321` |
| `SHOPIFY_LOCATION_STORD` | STORD Location ID | `1122334455` |
| `SHOPIFY_LOCATION_HK` | HK Warehouse Location ID | `5544332211` |

### Slack Notifications
Webhooks for alerting specific channels.

| Variable | Description | Example |
|----------|-------------|---------|
| `SLACK_WEBHOOK_SHOPIFY` | Shopify Order Errors | `https://hooks.slack.com/...` |
| `SLACK_WEBHOOK_GPS` | GPS Sync Errors | `https://hooks.slack.com/...` |
| `SLACK_WEBHOOK_GPS_LOW` | GPS Out of Stock Alerts | `https://hooks.slack.com/...` |
| `SLACK_WEBHOOK_STORD` | STORD Sync Errors | `https://hooks.slack.com/...` |
| `SLACK_WEBHOOK_DYNAMICS` | D365 Sync Errors | `https://hooks.slack.com/...` |
| `SLACK_WEBHOOK_ORDER` | Successful Orders | `https://hooks.slack.com/...` |
| `SLACK_WEBHOOK_GENERAL` | General Info/Errors | `https://hooks.slack.com/...` |
| `SLACK_WEBHOOK_SYSTEM` | System Errors | `https://hooks.slack.com/...` |

### Feature Flags & Settings
Toggle integrations and validation logic.

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_DYNAMICS_SYNC` | `true` | Enable/Disable D365 calls |
| `ENABLE_GPS_SYNC` | `true` | Enable/Disable GPS calls |
| `ENABLE_STORD_SYNC` | `true` | Enable/Disable STORD logic |
| `DRY_RUN_MODE` | `false` | Log actions without calling write APIs |
| `SKIP_HIGH_RISK_ORDERS` | `true` | Skip orders tagged `high-risk-order` |
| `SKIP_TEST_ORDERS` | `true` | Skip orders tagged `testing` or pre-live |
| `ORDERS_LIVE_DATE` | `2024-11-17...` | Date after which orders are real |

---

## API Calls Reference

### Dynamics 365 (Custom THK Services)
These endpoints use the `THK_APISyncServiceGroup` custom service group.

| Operation | Method | Endpoint | Description |
|-----------|--------|----------|-------------|
| **Confirm Order** | `POST` | `/api/services/THK_APISyncServiceGroup/THK_APISyncService_Shopify/confirmSO` | Confirms a created sales order. |
| **Create Prepayment** | `POST` | `/api/services/THK_APISyncServiceGroup/THK_APISyncService_Shopify/PostPrepayment` | Posts payment journal for the order. |
| **Create Fulfilment** | `POST` | `/api/services/THK_APISyncServiceGroup/THK_APISyncService_Shopify/fulfilment` | Creates Packing Slip (`type='PackingSlip'`) or Return Packing Slip (`type='return'`). |

### Dynamics 365 (OData Standard/Custom Entities)
These endpoints use standard OData v4.

| Operation | Method | Endpoint | Description |
|-----------|--------|----------|-------------|
| **Auth** | `POST` | `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token` | Get Bearer Token. |
| **Create Header** | `POST` | `/data/SalesOrderHeadersV3` | Creates Sales Order Header. |
| **Get Header** | `GET` | `/data/SalesOrderHeadersV3` | Helper to find order by Shopify ID (`THK_ShopifyReference`). |
| **Create Line** | `POST` | `/data/SalesOrderLines` | Creates Sales Order Line. |
| **Get Lines** | `GET` | `/data/SalesOrderLines` | Fetches lines for a Sales Order. |

### GPS Warehouse (OpenAPI)
These endpoints use JSON body and `authcode` query parameter signed with App Secret.

| Operation | Method | Endpoint | Description |
|-----------|--------|----------|-------------|
| **Create Order** | `POST` | `/openapi/v1/outboundOrder/create` | Sends Outbound Order to GPS. |
| **Get Details** | `POST` | `/openapi/v1/outboundOrder/detail` | **Polled via Cron**. Checks status of orders. Status `3` = Fulfilled. |

### Shopify (Admin REST API)
Standard Shopify Admin API.

| Operation | Method | Endpoint | Description |
|-----------|--------|----------|-------------|
| **Get Order** | `GET` | `/orders/{id}.json` | Fetches full order details. |
| **Get Unfulfilled** | `GET` | `/orders.json?status=open&fulfillment_status=unfulfilled` | **Polled via Cron**. Fetches pending orders to check against GPS. |
| **Get Fulfillment Orders** | `GET` | `/orders/{id}/fulfillment_orders.json` | Required to create a fulfillment (2023+ API). |
| **Create Fulfillment** | `POST` | `/fulfillments.json` | Marks order as fulfilled in Shopify with tracking info. |
