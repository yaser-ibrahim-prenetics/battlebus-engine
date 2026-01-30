#!/bin/bash

# ============================================================================
# ORDER REFUND TEST
# ============================================================================
# Tests refund flow: Shopify → D365 (Return Sales Order)
# Usage: ./scripts/test-order-refund.sh [ORDER_ID] [NGROK_URL]
# Example: ./scripts/test-order-refund.sh 176943909423269

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
REFUND_ID=$(date +%s)${RANDOM}

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
echo -e "${BLUE}Order Refund Test${NC}"
echo -e "${BLUE}============================================================================${NC}"
echo ""
echo -e "${GREEN}Order ID: ${ORDER_ID}${NC}"
echo -e "${GREEN}Order Name: ${ORDER_NAME}${NC}"
echo -e "${GREEN}Refund ID: ${REFUND_ID}${NC}"
echo -e "${GREEN}NGROK URL: ${NGROK_URL}${NC}"
echo ""

# Send refund webhook
echo -e "${YELLOW}Sending refunds/create webhook...${NC}"
curl -k -X POST "${NGROK_URL}/api/webhooks/shopify" \
  -H "Content-Type: application/json" \
  -H "x-shopify-topic: refunds/create" \
  -H "x-shopify-hmac-sha256: test" \
  -H "x-shopify-shop-domain: im8health.myshopify.com" \
  -d "{
    \"id\": ${REFUND_ID},
    \"order_id\": ${ORDER_ID},
    \"created_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
    \"note\": \"Test refund\",
    \"user_id\": null,
    \"processed_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
    \"refund_line_items\": [
      {
        \"id\": ${RANDOM},
        \"quantity\": 1,
        \"line_item_id\": 1,
        \"line_item\": {
          \"id\": 1,
          \"sku\": \"IM8-FG-000010\",
          \"name\": \"Test Product\",
          \"quantity\": 1,
          \"price\": \"89.00\"
        },
        \"subtotal\": \"89.00\"
      }
    ],
    \"transactions\": [
      {
        \"id\": ${RANDOM},
        \"order_id\": ${ORDER_ID},
        \"kind\": \"refund\",
        \"gateway\": \"shopify_payments\",
        \"status\": \"success\",
        \"amount\": \"89.00\"
      }
    ],
    \"order_adjustments\": []
  }" && echo ""

echo -e "${YELLOW}Waiting 15 seconds for processing...${NC}"
sleep 15

echo ""
echo -e "${GREEN}Checking Refund Logs...${NC}"
echo ""

# Check for refund activity
tail -500 "${BASE_DIR}/logs/pm2-out.log" | grep -E "${ORDER_NAME}|${REFUND_ID}|Refund|Return.*order|D365.*return|Credit|Error|error" | tail -40

echo ""
echo -e "${BLUE}============================================================================${NC}"
echo -e "${BLUE}Detailed Log Search${NC}"
echo -e "${BLUE}============================================================================${NC}"
echo ""
echo -e "${YELLOW}To see refund logs:${NC}"
echo "tail -1000 ${BASE_DIR}/logs/pm2-out.log | grep -E '${ORDER_NAME}|${REFUND_ID}|Refund|D365'"
echo ""

