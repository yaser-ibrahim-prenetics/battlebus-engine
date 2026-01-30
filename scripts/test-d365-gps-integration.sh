#!/bin/bash

# ============================================================================
# D365 + GPS INTEGRATION TEST
# ============================================================================
# Tests complete flow: Shopify Order → D365 Order → GPS Order
# Requires: ENABLE_DYNAMICS_SYNC=true and ENABLE_GPS_SYNC=true
# Usage: ./scripts/test-d365-gps-integration.sh [NGROK_URL]

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

# Get ngrok URL
if [ -z "$1" ]; then
  NGROK_URL=$(cd /Users/prenetics/work/Development/battle-bus/battle-bus-inngest && ./scripts/get-ngrok-urls.sh 2>/dev/null | grep "App Tunnel" | grep -o "https://[a-z0-9-]*\.ngrok-free\.app" | head -1)
  if [ -z "$NGROK_URL" ]; then
    NGROK_URL="https://b397937f982d.ngrok-free.app"
    echo -e "${YELLOW}⚠️  Could not auto-detect ngrok URL, using default: ${NGROK_URL}${NC}"
  fi
else
  NGROK_URL="$1"
fi

BASE_DIR="/Users/prenetics/work/Development/battle-bus/battle-bus-inngest"

echo -e "${BLUE}============================================================================${NC}"
echo -e "${BLUE}D365 + GPS Integration Test${NC}"
echo -e "${BLUE}NGROK URL: ${NGROK_URL}${NC}"
echo -e "${BLUE}============================================================================${NC}"
echo ""

# Generate unique order ID
ORDER_ID=$(date +%s)${RANDOM}
ORDER_NAME="#D365-GPS-${ORDER_ID}"

echo -e "${GREEN}Testing Complete Integration Flow${NC}"
echo "Order ID: ${ORDER_ID}"
echo "Order Name: ${ORDER_NAME}"
echo ""
echo -e "${YELLOW}Requirements:${NC}"
echo "  - ENABLE_DYNAMICS_SYNC=true (for D365)"
echo "  - ENABLE_GPS_SYNC=true (for GPS)"
echo "  - Order must have requires_shipping=true for GPS"
echo ""

# Send order webhook with proper structure for both D365 and GPS
curl -k -X POST "${NGROK_URL}/api/webhooks/shopify" \
  -H "Content-Type: application/json" \
  -H "x-shopify-topic: orders/paid" \
  -H "x-shopify-hmac-sha256: test" \
  -H "x-shopify-shop-domain: im8health.myshopify.com" \
  -d "{
    \"id\": ${ORDER_ID},
    \"name\": \"${ORDER_NAME}\",
    \"email\": \"d365-gps-${ORDER_ID}@example.com\",
    \"financial_status\": \"paid\",
    \"created_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
    \"total_price\": \"89.00\",
    \"currency\": \"USD\",
    \"tags\": \"\",
    \"test\": false,
    \"line_items\": [
      {
        \"id\": 1,
        \"sku\": \"IM8-FG-000010\",
        \"title\": \"Welcome Kit\",
        \"quantity\": 1,
        \"price\": \"89.00\",
        \"total_discount\": \"0.00\",
        \"requires_shipping\": true,
        \"gift_card\": false,
        \"grams\": 350,
        \"variant_id\": 12345
      }
    ],
    \"shipping_address\": {
      \"first_name\": \"Integration\",
      \"last_name\": \"Test\",
      \"address1\": \"123 Test St\",
      \"city\": \"Los Angeles\",
      \"province_code\": \"CA\",
      \"country_code\": \"US\",
      \"zip\": \"90001\",
      \"phone\": \"+1-555-111-2222\"
    },
    \"billing_address\": {
      \"first_name\": \"Integration\",
      \"last_name\": \"Test\",
      \"address1\": \"123 Test St\",
      \"city\": \"Los Angeles\",
      \"province_code\": \"CA\",
      \"country_code\": \"US\",
      \"zip\": \"90001\",
      \"phone\": \"+1-555-111-2222\"
    },
    \"customer\": {
      \"id\": 9999999,
      \"email\": \"d365-gps-${ORDER_ID}@example.com\",
      \"first_name\": \"Integration\",
      \"last_name\": \"Test\"
    }
  }" && echo ""

echo -e "${YELLOW}Waiting 15 seconds for processing...${NC}"
sleep 15

echo ""
echo -e "${GREEN}Checking Integration Logs...${NC}"
echo ""

# Check for D365 and GPS activity
tail -500 "${BASE_DIR}/logs/pm2-out.log" | grep -E "${ORDER_NAME}|D365|GPS|Authenticating|Creating sales order|Created sales order|Confirmed|GPS.*order|GPS.*result|Error|error" | tail -40

echo ""
echo -e "${BLUE}============================================================================${NC}"
echo -e "${BLUE}Detailed Log Search${NC}"
echo -e "${BLUE}============================================================================${NC}"
echo ""
echo -e "${YELLOW}To see D365 logs:${NC}"
echo "tail -1000 ${BASE_DIR}/logs/pm2-out.log | grep -E '${ORDER_NAME}|D365'"
echo ""
echo -e "${YELLOW}To see GPS logs:${NC}"
echo "tail -1000 ${BASE_DIR}/logs/pm2-out.log | grep -E '${ORDER_NAME}|GPS'"
echo ""
echo -e "${YELLOW}To see all logs for this order:${NC}"
echo "tail -1000 ${BASE_DIR}/logs/pm2-out.log | grep '${ORDER_NAME}'"
echo ""

