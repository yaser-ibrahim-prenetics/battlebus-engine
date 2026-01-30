#!/bin/bash

# ============================================================================
# DIRECT D365 API TEST - No Filters, Blind API Calls
# ============================================================================
# This script tests D365 API calls directly without any filters
# Usage: ./scripts/test-d365-direct.sh [NGROK_URL]

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

NGROK_URL="${1:-https://b397937f982d.ngrok-free.app}"
BASE_DIR="/Users/prenetics/work/Development/battle-bus/battle-bus-inngest"

echo -e "${BLUE}============================================================================${NC}"
echo -e "${BLUE}Direct D365 API Test - No Filters${NC}"
echo -e "${BLUE}NGROK URL: ${NGROK_URL}${NC}"
echo -e "${BLUE}============================================================================${NC}"
echo ""

# Generate unique order ID
ORDER_ID=$(date +%s)${RANDOM}
ORDER_NAME="#D365-DIRECT-${ORDER_ID}"

echo -e "${GREEN}Testing D365 Order Creation${NC}"
echo "Order ID: ${ORDER_ID}"
echo "Order Name: ${ORDER_NAME}"
echo ""

# Send order webhook - using any SKU, no filters
curl -k -X POST "${NGROK_URL}/api/webhooks/shopify" \
  -H "Content-Type: application/json" \
  -H "x-shopify-topic: orders/paid" \
  -H "x-shopify-hmac-sha256: test" \
  -H "x-shopify-shop-domain: im8health.myshopify.com" \
  -d "{
    \"id\": ${ORDER_ID},
    \"name\": \"${ORDER_NAME}\",
    \"email\": \"d365-direct-${ORDER_ID}@example.com\",
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
        \"title\": \"Test Product\",
        \"quantity\": 1,
        \"price\": \"89.00\",
        \"requires_shipping\": true,
        \"gift_card\": false,
        \"grams\": 350
      }
    ],
    \"shipping_address\": {
      \"first_name\": \"D365\",
      \"last_name\": \"Test\",
      \"address1\": \"123 Test St\",
      \"city\": \"Los Angeles\",
      \"province_code\": \"CA\",
      \"country_code\": \"US\",
      \"zip\": \"90001\",
      \"phone\": \"+1-555-111-2222\"
    },
    \"billing_address\": {
      \"country_code\": \"US\"
    },
    \"customer\": {
      \"id\": 9999999,
      \"email\": \"d365-direct-${ORDER_ID}@example.com\",
      \"first_name\": \"D365\",
      \"last_name\": \"Test\"
    }
  }" && echo ""

echo -e "${YELLOW}Waiting 10 seconds for D365 processing...${NC}"
sleep 10

echo ""
echo -e "${GREEN}Checking D365 logs...${NC}"
echo ""

# Check for D365 API calls
tail -200 "${BASE_DIR}/logs/pm2-out.log" | grep -E "${ORDER_NAME}|D365|Authenticating|Creating sales order|Created sales order|Confirmed|Error|error" | tail -30

echo ""
echo -e "${YELLOW}To see full logs:${NC}"
echo "tail -500 ${BASE_DIR}/logs/pm2-out.log | grep -E '${ORDER_NAME}|D365'"
echo ""

