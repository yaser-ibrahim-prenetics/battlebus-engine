#!/bin/bash

# ============================================================================
# ORDER CANCELLATION TEST
# ============================================================================
# Tests order cancellation flow: Shopify → D365
# Usage: ./scripts/test-order-cancellation.sh [ORDER_ID] [NGROK_URL]
# Example: ./scripts/test-order-cancellation.sh 176943909423269

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

# Get order ID from args or use the last test order
ORDER_ID="${1:-176943909423269}"
ORDER_NAME="#D365-GPS-${ORDER_ID}"

# Get ngrok URL
if [ -z "$2" ]; then
  NGROK_URL=$(cd /Users/prenetics/work/Development/battle-bus/battle-bus-inngest && ./scripts/get-ngrok-urls.sh 2>/dev/null | grep "App Tunnel" | grep -o "https://[a-z0-9-]*\.ngrok-free\.app" | head -1)
  if [ -z "$NGROK_URL" ]; then
    NGROK_URL="https://b397937f982d.ngrok-free.app"
    echo -e "${YELLOW}⚠️  Could not auto-detect ngrok URL, using default: ${NGROK_URL}${NC}"
  fi
else
  NGROK_URL="$2"
fi

BASE_DIR="/Users/prenetics/work/Development/battle-bus/battle-bus-inngest"

echo -e "${BLUE}============================================================================${NC}"
echo -e "${BLUE}Order Cancellation Test${NC}"
echo -e "${BLUE}============================================================================${NC}"
echo ""
echo -e "${GREEN}Order ID: ${ORDER_ID}${NC}"
echo -e "${GREEN}Order Name: ${ORDER_NAME}${NC}"
echo -e "${GREEN}NGROK URL: ${NGROK_URL}${NC}"
echo ""

# Send cancellation webhook
echo -e "${YELLOW}Sending orders/cancelled webhook...${NC}"
curl -k -X POST "${NGROK_URL}/api/webhooks/shopify" \
  -H "Content-Type: application/json" \
  -H "x-shopify-topic: orders/cancelled" \
  -H "x-shopify-hmac-sha256: test" \
  -H "x-shopify-shop-domain: im8health.myshopify.com" \
  -d "{
    \"id\": ${ORDER_ID},
    \"name\": \"${ORDER_NAME}\",
    \"email\": \"d365-gps-${ORDER_ID}@example.com\",
    \"financial_status\": \"refunded\",
    \"fulfillment_status\": null,
    \"created_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
    \"cancelled_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
    \"cancel_reason\": \"customer\",
    \"total_price\": \"89.00\",
    \"currency\": \"USD\",
    \"tags\": \"\",
    \"test\": false,
    \"line_items\": [
      {
        \"id\": 1,
        \"sku\": \"IM8-FG-000010\",
        \"title\": \"Test Product\",
        \"quantity\": 1,
        \"price\": \"89.00\",
        \"requires_shipping\": true,
        \"gift_card\": false
      }
    ],
    \"shipping_address\": {
      \"first_name\": \"Integration\",
      \"last_name\": \"Test\",
      \"address1\": \"123 Test St\",
      \"city\": \"Los Angeles\",
      \"province_code\": \"CA\",
      \"country_code\": \"US\",
      \"zip\": \"90001\"
    },
    \"billing_address\": {
      \"country_code\": \"US\"
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
echo -e "${GREEN}Checking Cancellation Logs...${NC}"
echo ""

# Check for cancellation activity
tail -500 "${BASE_DIR}/logs/pm2-out.log" | grep -E "${ORDER_NAME}|Cancell|D365.*cancel|GPS.*cancel|Return.*order|Error|error" | tail -40

echo ""
echo -e "${BLUE}============================================================================${NC}"
echo -e "${BLUE}Detailed Log Search${NC}"
echo -e "${BLUE}============================================================================${NC}"
echo ""
echo -e "${YELLOW}To see cancellation logs:${NC}"
echo "tail -1000 ${BASE_DIR}/logs/pm2-out.log | grep -E '${ORDER_NAME}|Cancell|D365'"
echo ""

